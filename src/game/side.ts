/**
 * The two sides of the table, split by the net at z = 0: the player's half
 * (+z) and the Opponent's (−z). In Return Drill the Feeder stands at the
 * Opponent's end, so its Feeds come from the 'opponent' side too.
 */
export type Side = 'player' | 'opponent';

/** The side across the net from `side`. */
export function otherSide(side: Side): Side {
  return side === 'player' ? 'opponent' : 'player';
}
