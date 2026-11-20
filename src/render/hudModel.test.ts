import { describe, expect, it } from 'vitest';
import { awardPoint, newMatch, startRally, type MatchConfig, type MatchState } from '../game/match.ts';
import type { Side } from '../game/side.ts';
import { hudModel, matchHud } from './hudModel.ts';

const ONE_GAME: MatchConfig = { pointsToWin: 11, winBy: 2, bestOf: 1 };
const BEST_OF_3: MatchConfig = { pointsToWin: 11, winBy: 2, bestOf: 3 };

/** A Match at `player`–`opponent`, played Point by Point so the server is the real one. */
function at(player: number, opponent: number, cfg = ONE_GAME, first: Side = 'player'): MatchState {
  let s = newMatch(cfg, first);
  const order: Side[] = [];
  for (let i = 0; i < Math.max(player, opponent); i++) {
    if (i < player) order.push('player');
    if (i < opponent) order.push('opponent');
  }
  for (const to of order) s = awardPoint(startRally(s), to, cfg);
  return s;
}

describe('matchHud', () => {
  it('shows the score, player first, with an en dash', () => {
    const m = matchHud(at(7, 5), ONE_GAME, null);
    expect(m.score).toBe('7 – 5');
    expect(m.banner).toBeNull();
    expect(m.status).toBeNull();
  });

  it('calls Game point for the side one Point from the Game, and not before', () => {
    expect(matchHud(at(10, 4), ONE_GAME, null).status).toBe('Game point');
    expect(matchHud(at(4, 10), ONE_GAME, null).status).toBe('Game point');
    expect(matchHud(at(9, 4), ONE_GAME, null).status).toBeNull();
  });

  it('calls Deuce when both sides are a Point short or more and level; the leader then has Game point', () => {
    expect(matchHud(at(10, 10), ONE_GAME, null).status).toBe('Deuce');
    expect(matchHud(at(12, 12), ONE_GAME, null).status).toBe('Deuce');
    expect(matchHud(at(11, 10), ONE_GAME, null).status).toBe('Game point');
    expect(matchHud(at(9, 9), ONE_GAME, null).status).toBeNull();
  });

  it('words the banner for a Point, a Fault and a Let', () => {
    const m = at(1, 0);
    expect(matchHud(m, ONE_GAME, { type: 'point', to: 'player', end: 'unreturned' }).banner).toBe('Point to you');
    expect(matchHud(m, ONE_GAME, { type: 'point', to: 'opponent', end: 'net' }).banner).toBe('Point to Opponent');
    expect(matchHud(m, ONE_GAME, { type: 'point', to: 'opponent', end: 'fault' }).banner).toBe('Fault');
    expect(matchHud(m, ONE_GAME, { type: 'let' }).banner).toBe('Let');
    expect(matchHud(m, ONE_GAME, { type: 'next-game' }).banner).toBeNull();
  });

  it('shows the Games line only in a best of 3', () => {
    expect(matchHud(at(0, 0), ONE_GAME, null).gamesLine).toBeNull();
    expect(matchHud(at(0, 0, BEST_OF_3), BEST_OF_3, null).gamesLine).toBe('Games 0 – 0');
    const s = at(11, 0, BEST_OF_3);
    expect(s.games.player).toBe(1);
    expect(matchHud(s, BEST_OF_3, null).gamesLine).toBe('Games 1 – 0');
  });

  it('shows the server and the Serves left, changing after each Point', () => {
    let s = newMatch(ONE_GAME, 'player');
    const view = () => matchHud(s, ONE_GAME, null).serving;
    expect(view()).toEqual({ side: 'player', servesLeft: 2 });
    s = awardPoint(startRally(s), 'opponent', ONE_GAME);
    expect(view()).toEqual({ side: 'player', servesLeft: 1 });
    s = awardPoint(startRally(s), 'player', ONE_GAME);
    expect(view()).toEqual({ side: 'opponent', servesLeft: 2 });
    s = awardPoint(startRally(s), 'player', ONE_GAME);
    expect(view()).toEqual({ side: 'opponent', servesLeft: 1 });
    s = awardPoint(startRally(s), 'player', ONE_GAME);
    expect(view()).toEqual({ side: 'player', servesLeft: 2 });
  });

  it('shows one Serve per turn at deuce', () => {
    expect(matchHud(at(10, 10), ONE_GAME, null).serving?.servesLeft).toBe(1);
  });

  it('shows no server and no status once the Game is decided', () => {
    const s = at(11, 3);
    expect(s.phase).toBe('match-over');
    const m = matchHud(s, ONE_GAME, { type: 'point', to: 'player', end: 'unreturned' });
    expect(m.serving).toBeNull();
    expect(m.status).toBeNull();
    expect(m.score).toBe('11 – 3');
  });
});

describe('hudModel (the spec contract)', () => {
  it('has the score, the server and the hand-lost flag, and no games or banner in a plain moment', () => {
    expect(hudModel(at(7, 5), null, false)).toEqual({ score: '7 – 5', serving: 'player', servesLeft: 2, handLost: false });
    expect(hudModel(at(7, 5), null, true).handLost).toBe(true);
  });

  it('words the banner from the last Rally event or Serve result', () => {
    const m = at(7, 5);
    expect(hudModel(m, { type: 'end', atMs: 0, end: 'net', loser: 'opponent' }, false).banner).toBe('Point to you');
    expect(hudModel(m, { type: 'end', atMs: 0, end: 'unreturned', loser: 'player' }, false).banner).toBe('Point to Opponent');
    expect(hudModel(m, { type: 'serve', atMs: 0, by: 'opponent', result: 'fault' }, false).banner).toBe('Fault');
    expect(hudModel(m, 'let', false).banner).toBe('Let');
    expect(hudModel(m, 'legal', false).banner).toBeUndefined();
  });

  it('falls back to Game point and Deuce, and adds Games in a best of 3', () => {
    expect(hudModel(at(10, 4), null, false).banner).toBe('Game point');
    expect(hudModel(at(10, 10), null, false).banner).toBe('Deuce');
    expect(hudModel(at(2, 1, BEST_OF_3), null, false, BEST_OF_3).games).toBe('Games 0 – 0');
  });
});
