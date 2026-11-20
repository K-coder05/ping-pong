/**
 * A simulated player for the balance harness (spec P2-g2): it swings at every
 * Shot coming to the player, and at its own Serve toss, the way a fitted
 * `PlayerModel` does. For each Incoming toward the player it draws, in a
 * fixed order, whether the Swing is seen (`detectRate`), its timing (Ideal
 * Time + Timing Offset + Gaussian error, so the resolver sees the model's
 * timing error once the offset is taken off), its speed and its vertical
 * path, and emits the Swing once its Onset is due (`advance`).
 *
 * The side is the hitting hand's side of the ball at its Ideal Time: a
 * Forehand on that side, a Backhand across the body. It only picks the
 * Return's direction, never whether it succeeds.
 */

import { TIMING_OFFSET_MS } from '../game/constants.ts';
import type { GameCore } from '../game/core.ts';
import type { Incoming } from '../game/rally.ts';
import type { SwingEvent, SwingSource } from '../input/types.ts';
import type { Hand } from '../sensing/landmarks.ts';
import type { PlayerModel } from './fitPlayer.ts';

export interface SimPlayer extends SwingSource {
  /**
   * The clock moved to `nowMs` (call once per frame, before `core.frame`):
   * emit the pending Swing if its Onset is due.
   */
  advance(nowMs: number): void;
}

export interface SimPlayerOptions {
  /** The hitting hand, for Forehand or Backhand; right unless told otherwise. */
  hand?: Hand;
}

export function createSimPlayer(
  model: PlayerModel,
  core: Pick<GameCore, 'onIncoming'>,
  random: () => number,
  options: SimPlayerOptions = {},
): SimPlayer {
  const handSign = (options.hand ?? 'right') === 'right' ? 1 : -1;
  const listeners = new Set<(swing: SwingEvent) => void>();
  /** The Swing at the latest Incoming toward the player, until it is emitted. */
  let pending: SwingEvent | null = null;

  core.onIncoming((incoming: Incoming) => {
    if (incoming.receiver !== 'player') return;
    // Always the same draws per Incoming, seen or not, so one dropped Swing doesn't shift the rest.
    const seen = random() < model.detectRate;
    const t = incoming.idealAtMs + TIMING_OFFSET_MS.value + model.timingMeanMs + model.timingSdMs * gaussian(random);
    const peakSpeed = model.speedMean + model.speedSd * gaussian(random);
    const vertPath = model.vertPathMean + model.vertPathSd * gaussian(random);
    const side: SwingEvent['side'] = incoming.strike.position.x * handSign >= 0 ? 'forehand' : 'backhand';
    pending = seen ? { t, peakSpeed, side, vertPath } : null;
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    advance(nowMs) {
      if (!pending || nowMs < pending.t) return;
      const swing = pending;
      pending = null;
      for (const listener of listeners) listener(swing);
    },
  };
}

/** A standard normal draw from one uniform draw pair (Box–Muller, cosine half). */
function gaussian(random: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}
