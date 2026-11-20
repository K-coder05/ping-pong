import type { MatchConfig, MatchState } from '../game/match.ts';
import { DEFAULT_MATCH_CONFIG } from '../game/core.ts';
import type { RallyEvent } from '../game/rally.ts';
import type { ServeResult } from '../game/serve.ts';
import { otherSide, type Side } from '../game/side.ts';

/**
 * What the Match HUD shows, worked out from the Match state (pure: no DOM).
 * `hud.ts` draws it.
 */

/** The Match events the HUD words as a banner (a `MatchEvent` from the core fits). */
export type HudEvent =
  | { readonly type: 'point'; readonly to: Side; readonly end: string }
  | { readonly type: 'let' }
  | { readonly type: 'next-game' };

export interface MatchHudModel {
  /** "7 – 5", the player's Points first. */
  readonly score: string;
  /** "Games 1 – 0" in a best of 3 or more; null in a single Game. */
  readonly gamesLine: string | null;
  /** Who serves and how many Serves they have left in this turn (counting the next one); null once a Game is decided. */
  readonly serving: { readonly side: Side; readonly servesLeft: number } | null;
  /** The short message for the latest event ("Point to you", "Fault", "Let"), else null. */
  readonly banner: string | null;
  /** The standing situation: "Game point" or "Deuce", else null. */
  readonly status: 'Game point' | 'Deuce' | null;
}

const WHO: Record<Side, string> = { player: 'you', opponent: 'Opponent' };

function bannerFor(event: HudEvent | null): string | null {
  if (!event) return null;
  if (event.type === 'let') return 'Let';
  if (event.type === 'point') return event.end === 'fault' ? 'Fault' : `Point to ${WHO[event.to]}`;
  return null;
}

function statusFor(match: MatchState, cfg: MatchConfig): MatchHudModel['status'] {
  if (match.phase === 'game-over' || match.phase === 'match-over') return null;
  const { player, opponent } = match.points;
  const wins = (a: number, b: number) => a + 1 >= cfg.pointsToWin && a + 1 - b >= cfg.winBy;
  if (wins(player, opponent) || wins(opponent, player)) return 'Game point';
  if (player === opponent && player >= cfg.pointsToWin - 1) return 'Deuce';
  return null;
}

export function matchHud(match: Readonly<MatchState>, cfg: Readonly<MatchConfig>, event: HudEvent | null): MatchHudModel {
  const decided = match.phase === 'game-over' || match.phase === 'match-over';
  return {
    score: `${match.points.player} – ${match.points.opponent}`,
    gamesLine: cfg.bestOf > 1 ? `Games ${match.games.player} – ${match.games.opponent}` : null,
    serving: decided ? null : { side: match.server, servesLeft: match.servesLeft },
    banner: bannerFor(event),
    status: statusFor(match, cfg),
  };
}

/** The spec's HUD model (P2-h1): the same facts in one flat shape. */
export interface HudModel {
  /** "7 – 5", player first. */
  score: string;
  /** "Games 1 – 0" when bestOf > 1. */
  games?: string;
  serving: Side;
  servesLeft: number;
  /** "Point to you", "Point to Opponent", "Fault", "Let", else the standing "Game point" or "Deuce". */
  banner?: string;
  handLost: boolean;
}

/** The latest Rally event or Serve result as an event `matchHud` can word. */
function asHudEvent(last: RallyEvent | ServeResult | null): HudEvent | null {
  if (last === null) return null;
  if (last === 'let') return { type: 'let' };
  if (last === 'fault') return { type: 'point', to: 'player', end: 'fault' };
  if (last === 'legal') return null;
  if (last.type === 'serve') return asHudEvent(last.result);
  if (last.type === 'end') return { type: 'point', to: otherSide(last.loser), end: last.end };
  return null;
}

export function hudModel(
  s: Readonly<MatchState>,
  lastEvent: RallyEvent | ServeResult | null,
  handLost: boolean,
  cfg: Readonly<MatchConfig> = DEFAULT_MATCH_CONFIG,
): HudModel {
  const m = matchHud(s, cfg, asHudEvent(lastEvent));
  return {
    score: m.score,
    ...(m.gamesLine ? { games: m.gamesLine } : {}),
    serving: s.server,
    servesLeft: s.servesLeft,
    ...((m.banner ?? m.status) ? { banner: (m.banner ?? m.status)! } : {}),
    handLost,
  };
}
