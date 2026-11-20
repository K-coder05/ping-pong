import { otherSide, type Side } from './side.ts';

/**
 * Match rules: a pure scoring state machine for a Game to `pointsToWin`
 * (win by `winBy`) and a Match of `bestOf` Games. Every function returns a new
 * state and never mutates its input; an invalid call throws.
 */
export interface MatchConfig {
  pointsToWin: number; // 11
  winBy: number; // 2
  bestOf: number; // 1 or 3
}

/**
 * `servesLeft` is the number of Serves the current `server` still has in this
 * turn, counting the one about to be served (or being played). A Game starts
 * with `servesLeft` 2; it drops by one with each Point and, at 0, the Serve
 * passes with `servesLeft` back to 2. From 10-10 on (both sides one Point short
 * of `pointsToWin`) a turn is a single Serve, so `servesLeft` is 1.
 * A Let (`cancelRally`) does not use up a Serve.
 *
 * `phase` moves: pre-serve --startRally--> rally --awardPoint--> pre-serve,
 * or game-over when that Point wins a Game, or match-over when it wins the
 * Match. `cancelRally` takes rally back to pre-serve. `nextGame` takes
 * game-over to the pre-serve of the next Game. `winner` is set only at
 * match-over. After a game-over the score and server stay as they were at the
 * last Point.
 */
export interface MatchState {
  games: Record<Side, number>;
  points: Record<Side, number>;
  server: Side;
  servesLeft: number;
  gameFirstServer: Side;
  phase: 'pre-serve' | 'rally' | 'game-over' | 'match-over';
  winner?: Side;
}

function checkConfig(cfg: MatchConfig): void {
  const ok = Number.isInteger(cfg.pointsToWin) && cfg.pointsToWin >= 1
    && Number.isInteger(cfg.winBy) && cfg.winBy >= 1
    && Number.isInteger(cfg.bestOf) && cfg.bestOf >= 1 && cfg.bestOf % 2 === 1;
  if (!ok) throw new Error(`Invalid match config: ${JSON.stringify(cfg)}`);
}

/** Serves per turn at this score: 2, or 1 once both sides are within a Point of the target. */
function servesPerTurn(points: Record<Side, number>, cfg: MatchConfig): number {
  const deuce = points.player >= cfg.pointsToWin - 1 && points.opponent >= cfg.pointsToWin - 1;
  return deuce ? 1 : 2;
}

export function newMatch(cfg: MatchConfig, firstServer: Side): MatchState {
  checkConfig(cfg);
  const points = { player: 0, opponent: 0 };
  return {
    games: { player: 0, opponent: 0 },
    points,
    server: firstServer,
    servesLeft: servesPerTurn(points, cfg),
    gameFirstServer: firstServer,
    phase: 'pre-serve',
  };
}

function expectPhase(s: MatchState, phase: MatchState['phase'], fn: string): void {
  if (s.phase !== phase) throw new Error(`${fn}: not allowed in phase '${s.phase}' (needs '${phase}')`);
}

export function startRally(s: MatchState): MatchState {
  expectPhase(s, 'pre-serve', 'startRally');
  return { ...s, phase: 'rally' };
}

/** A Let, or a Rally interrupted by lost tracking: back to pre-serve, same server, no Point. */
export function cancelRally(s: MatchState): MatchState {
  expectPhase(s, 'rally', 'cancelRally');
  return { ...s, phase: 'pre-serve' };
}

export function awardPoint(s: MatchState, to: Side, cfg: MatchConfig): MatchState {
  checkConfig(cfg);
  expectPhase(s, 'rally', 'awardPoint');
  const points = { ...s.points, [to]: s.points[to] + 1 };
  const lead = points[to] - points[otherSide(to)];

  if (points[to] >= cfg.pointsToWin && lead >= cfg.winBy) {
    const games = { ...s.games, [to]: s.games[to] + 1 };
    const matchWon = games[to] >= Math.ceil(cfg.bestOf / 2);
    return matchWon
      ? { ...s, points, games, phase: 'match-over', winner: to }
      : { ...s, points, games, phase: 'game-over' };
  }

  const perTurn = servesPerTurn(points, cfg);
  const left = s.servesLeft - 1;
  return left <= 0 || perTurn === 1
    ? { ...s, points, server: otherSide(s.server), servesLeft: perTurn, phase: 'pre-serve' }
    : { ...s, points, servesLeft: left, phase: 'pre-serve' };
}

/** From game-over: 0-0, and the side that received first in the last Game serves first. */
export function nextGame(s: MatchState, cfg: MatchConfig): MatchState {
  checkConfig(cfg);
  expectPhase(s, 'game-over', 'nextGame');
  const points = { player: 0, opponent: 0 };
  const first = otherSide(s.gameFirstServer);
  return {
    games: s.games,
    points,
    server: first,
    servesLeft: servesPerTurn(points, cfg),
    gameFirstServer: first,
    phase: 'pre-serve',
  };
}
