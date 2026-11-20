import { describe, expect, it } from 'vitest';
import { makeRng } from '../util/rng.ts';
import {
  awardPoint, cancelRally, newMatch, nextGame, startRally,
  type MatchConfig, type MatchState,
} from './match.ts';
import { otherSide, type Side } from './side.ts';

const BEST_OF_1: MatchConfig = { pointsToWin: 11, winBy: 2, bestOf: 1 };
const BEST_OF_3: MatchConfig = { pointsToWin: 11, winBy: 2, bestOf: 3 };

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

/** Play one Rally won by `to`. */
function point(s: MatchState, to: Side, cfg: MatchConfig): MatchState {
  return awardPoint(startRally(s), to, cfg);
}
function play(s: MatchState, winners: Side[], cfg: MatchConfig): MatchState {
  return winners.reduce((st, w) => point(st, w, cfg), s);
}
const times = (n: number, side: Side): Side[] => Array<Side>(n).fill(side);
/** Alternating Points to reach n-n, player first. */
const tied = (n: number): Side[] => Array.from({ length: 2 * n }, (_, i): Side => (i % 2 === 0 ? 'player' : 'opponent'));

describe('Game scores', () => {
  const cases: { name: string; winners: Side[]; score: [number, number]; over: boolean }[] = [
    { name: '11-0', winners: times(11, 'player'), score: [11, 0], over: true },
    { name: '11-9', winners: [...tied(9), ...times(2, 'player')], score: [11, 9], over: true },
    { name: '10-10 then 12-10', winners: [...tied(10), ...times(2, 'player')], score: [12, 10], over: true },
    { name: '10-10, 11-11, 13-11', winners: [...tied(10), 'player', 'opponent', 'player', 'player'], score: [13, 11], over: true },
    { name: 'deuce up to 20-20 then 22-20', winners: [...tied(20), 'player', 'player'], score: [22, 20], over: true },
    { name: '10-9 is not yet won', winners: [...tied(9), 'player'], score: [10, 9], over: false },
    { name: '11-10 is not yet won', winners: [...tied(10), 'player'], score: [11, 10], over: false },
    { name: 'Opponent wins 11-5', winners: [...tied(5), ...times(6, 'opponent')], score: [5, 11], over: true },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const s = play(newMatch(BEST_OF_1, 'player'), c.winners, BEST_OF_1);
      expect([s.points.player, s.points.opponent]).toEqual(c.score);
      expect(s.phase).toBe(c.over ? 'match-over' : 'pre-serve');
    });
  }

  it('in best of 3 a Game win is game-over, not match-over', () => {
    const s = play(newMatch(BEST_OF_3, 'player'), times(11, 'player'), BEST_OF_3);
    expect(s.phase).toBe('game-over');
    expect(s.games).toEqual({ player: 1, opponent: 0 });
    expect(s.winner).toBeUndefined();
  });
});

describe('Serve rotation', () => {
  it('passes every 2 Points from 0-0 to 11-9', () => {
    let s = newMatch(BEST_OF_1, 'opponent');
    const winners: Side[] = [...tied(9), ...times(2, 'player')]; // 11-9, 20 Points
    winners.forEach((w, i) => {
      const expected: Side = Math.floor(i / 2) % 2 === 0 ? 'opponent' : 'player';
      expect(s.server).toBe(expected);
      expect(s.servesLeft).toBe(2 - (i % 2));
      s = point(s, w, BEST_OF_1);
    });
  });

  it('passes every Point from 10-10 on', () => {
    let s = play(newMatch(BEST_OF_1, 'player'), tied(10), BEST_OF_1);
    // 20 Points played, 10 turns of 2: the Serve is back with the first server.
    expect(s.server).toBe('player');
    expect(s.servesLeft).toBe(1);
    for (let i = 0; i < 10; i++) {
      const before = s.server;
      s = point(s, i % 2 === 0 ? 'player' : 'opponent', BEST_OF_1); // never leads by 2
      expect(s.server).toBe(otherSide(before));
      expect(s.servesLeft).toBe(1);
    }
  });

  it('reaching 10-10 from 9-10 keeps the schedule', () => {
    let s = play(newMatch(BEST_OF_1, 'player'), [...tied(9), 'opponent'], BEST_OF_1); // 9-10
    expect(s.server).toBe('opponent'); // 19 Points: second Serve of the 10th turn
    expect(s.servesLeft).toBe(1);
    s = point(s, 'player', BEST_OF_1); // 10-10
    expect(s.server).toBe('player');
    expect(s.servesLeft).toBe(1);
  });
});

describe('cancelRally', () => {
  it('changes nothing but the phase', () => {
    const starts = [
      newMatch(BEST_OF_3, 'player'),
      play(newMatch(BEST_OF_3, 'opponent'), ['player', 'opponent', 'player'], BEST_OF_3),
    ];
    for (const start of starts) {
      const rallying = startRally(start);
      const cancelled = cancelRally(rallying);
      expect(cancelled).toEqual({ ...rallying, phase: 'pre-serve' });
      expect(cancelled).toEqual(start);
    }
  });
});

describe('best of 3', () => {
  it('alternates the first server and ends at 2 Games', () => {
    let s = newMatch(BEST_OF_3, 'player');
    s = play(s, times(11, 'opponent'), BEST_OF_3);
    expect(s.phase).toBe('game-over');
    s = nextGame(s, BEST_OF_3);
    expect(s).toMatchObject({ games: { player: 0, opponent: 1 }, points: { player: 0, opponent: 0 }, server: 'opponent', gameFirstServer: 'opponent', servesLeft: 2, phase: 'pre-serve' });
    s = play(s, times(11, 'player'), BEST_OF_3);
    expect(s.phase).toBe('game-over');
    s = nextGame(s, BEST_OF_3);
    expect(s).toMatchObject({ games: { player: 1, opponent: 1 }, server: 'player', gameFirstServer: 'player' });
    s = play(s, times(11, 'player'), BEST_OF_3);
    expect(s).toMatchObject({ phase: 'match-over', winner: 'player', games: { player: 2, opponent: 1 } });
  });

  it('ends 2-0 without a third Game', () => {
    let s = newMatch(BEST_OF_3, 'opponent');
    s = nextGame(play(s, times(11, 'player'), BEST_OF_3), BEST_OF_3);
    s = play(s, times(11, 'player'), BEST_OF_3);
    expect(s).toMatchObject({ phase: 'match-over', winner: 'player' });
  });
});

describe('invalid calls throw', () => {
  it('awardPoint outside a rally', () => {
    expect(() => awardPoint(newMatch(BEST_OF_1, 'player'), 'player', BEST_OF_1)).toThrow();
  });
  it('startRally twice, cancelRally before a rally, nextGame mid-Game', () => {
    const s = newMatch(BEST_OF_3, 'player');
    expect(() => startRally(startRally(s))).toThrow();
    expect(() => cancelRally(s)).toThrow();
    expect(() => nextGame(s, BEST_OF_3)).toThrow();
  });
  it('anything after match-over, and startRally in game-over', () => {
    const over = play(newMatch(BEST_OF_1, 'player'), times(11, 'player'), BEST_OF_1);
    expect(() => startRally(over)).toThrow();
    expect(() => cancelRally(over)).toThrow();
    expect(() => awardPoint(over, 'player', BEST_OF_1)).toThrow();
    expect(() => nextGame(over, BEST_OF_1)).toThrow();
    const gameOver = play(newMatch(BEST_OF_3, 'player'), times(11, 'player'), BEST_OF_3);
    expect(() => startRally(gameOver)).toThrow();
  });
  it('rejects an invalid config', () => {
    expect(() => newMatch({ pointsToWin: 11, winBy: 2, bestOf: 2 }, 'player')).toThrow();
    expect(() => newMatch({ pointsToWin: 0, winBy: 2, bestOf: 1 }, 'player')).toThrow();
  });
});

describe('purity', () => {
  it('never mutates its input', () => {
    let s = deepFreeze(newMatch(BEST_OF_3, 'player'));
    s = deepFreeze(startRally(s));
    s = deepFreeze(cancelRally(s));
    s = deepFreeze(point(s, 'player', BEST_OF_3));
    const won = deepFreeze(play(newMatch(BEST_OF_3, 'player'), times(11, 'player'), BEST_OF_3));
    expect(() => nextGame(won, BEST_OF_3)).not.toThrow();
  });
});

describe('property: random Point sequences', () => {
  it('never reach an impossible state', () => {
    const random = makeRng(2026);
    for (let run = 0; run < 10_000; run++) {
      const cfg = random() < 0.5 ? BEST_OF_1 : BEST_OF_3;
      const bias = random();
      let s = newMatch(cfg, random() < 0.5 ? 'player' : 'opponent');
      let steps = 0;
      while (s.phase !== 'match-over') {
        if (++steps > 5000) throw new Error('Match never ended');
        if (s.phase === 'game-over') {
          const prevFirst = s.gameFirstServer;
          s = nextGame(s, cfg);
          expect(s.gameFirstServer).toBe(otherSide(prevFirst));
          expect(s.server).toBe(s.gameFirstServer);
          expect(s.points).toEqual({ player: 0, opponent: 0 });
          continue;
        }
        s = startRally(s);
        if (random() < 0.1) {
          const before = s;
          s = cancelRally(s);
          expect(s).toEqual({ ...before, phase: 'pre-serve' });
          continue;
        }
        const prev = s;
        const to: Side = random() < 0.2 + 0.6 * bias ? 'player' : 'opponent';
        s = awardPoint(s, to, cfg);
        expect(s.points[to]).toBe(prev.points[to] + 1);
        expect(s.points[otherSide(to)]).toBe(prev.points[otherSide(to)]);

        const { player: p, opponent: o } = s.points;
        const ended = s.phase === 'game-over' || s.phase === 'match-over';
        if (ended) {
          expect(Math.max(p, o)).toBeGreaterThanOrEqual(cfg.pointsToWin);
          expect(Math.abs(p - o)).toBeGreaterThanOrEqual(cfg.winBy);
          expect(to === 'player' ? p > o : o > p).toBe(true);
        } else {
          expect(Math.max(p, o) < cfg.pointsToWin || Math.abs(p - o) < cfg.winBy).toBe(true);
          expect(s.phase).toBe('pre-serve');
          // The server follows from the Game's first server and the Points played.
          const deuce = p >= 10 && o >= 10;
          const turns = deuce ? 10 + (p + o - 20) : Math.floor((p + o) / 2);
          expect(s.server).toBe(turns % 2 === 0 ? s.gameFirstServer : otherSide(s.gameFirstServer));
          expect(s.servesLeft).toBe(deuce ? 1 : 2 - ((p + o) % 2));
        }
        const half = Math.ceil(cfg.bestOf / 2);
        expect(s.games.player).toBeLessThanOrEqual(half);
        expect(s.games.opponent).toBeLessThanOrEqual(half);
        if (s.phase === 'match-over') {
          expect(s.winner).toBe(to);
          expect(s.games[to]).toBe(half);
        } else {
          expect(s.winner).toBeUndefined();
        }
      }
    }
  }, 120_000);
});
