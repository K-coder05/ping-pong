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
 *
 * With `phone` (spec P3-f), it plays with the Phone instead of the Camera:
 * everything above is drawn the same way, then its Face Angle, which matches
 * the incoming Shot's Spin (the Face Angle whose share equals the Spin's
 * share of SPIN_ANSWER_FULL_REVS, so it answers it exactly) plus Gaussian
 * error. Its Swings carry that `faceAngle` and a `vertPath` of 0, as the
 * Phone's do (the vertical path is still drawn, so the draws stay in step).
 */

import { SPIN_ANSWER_FULL_REVS, TIMING_OFFSET_MS } from '../game/constants.ts';
import type { GameCore } from '../game/core.ts';
import type { BallState } from '../game/ball.ts';
import { faceAngleForShare, knobFaceAngleParams } from '../game/faceAngle.ts';
import type { Incoming } from '../game/rally.ts';
import type { SwingEvent, SwingSource } from '../input/types.ts';
import { revsToRadPerSec } from '../physics/spin.ts';
import type { Hand } from '../sensing/landmarks.ts';
import type { PlayerModel } from './fitPlayer.ts';

export interface SimPlayer extends SwingSource {
  /**
   * The clock moved to `nowMs` (call once per frame, before `core.frame`):
   * emit the pending Swing if its Onset is due.
   */
  advance(nowMs: number): void;
}

/** How a simulated Phone player sets its Face Angle (spec P3-f). */
export interface PhoneModel {
  /** Standard deviation of its Face Angle about the one that matches the incoming Spin, degrees. */
  faceAngleSdDeg: number;
}

export interface SimPlayerOptions {
  /** The hitting hand, for Forehand or Backhand; right unless told otherwise. */
  hand?: Hand;
  /** Play with the Phone: Swings carry a Face Angle that answers the incoming Spin. Omitted: the Camera. */
  phone?: PhoneModel;
}

export function createSimPlayer(
  model: PlayerModel,
  core: Pick<GameCore, 'onIncoming'>,
  random: () => number,
  options: SimPlayerOptions = {},
): SimPlayer {
  const handSign = (options.hand ?? 'right') === 'right' ? 1 : -1;
  const { phone } = options;
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
    if (phone) {
      const full = revsToRadPerSec(SPIN_ANSWER_FULL_REVS);
      const share = Math.min(1, Math.max(-1, topspinOf(incoming.ball) / full));
      const faceAngle = faceAngleForShare(share, knobFaceAngleParams()) + ((phone.faceAngleSdDeg * Math.PI) / 180) * gaussian(random);
      pending = seen ? { t, peakSpeed, side, vertPath: 0, faceAngle } : null;
    } else {
      pending = seen ? { t, peakSpeed, side, vertPath } : null;
    }
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

/**
 * A Shot's Topspin at launch, rad/s (negative = Backspin): its spin about the
 * horizontal axis across its direction of travel, as `spinVector` built it.
 * 0 for a ball with no horizontal motion.
 */
export function topspinOf(ball: Pick<BallState, 'velocity' | 'spin'>): number {
  const { x, z } = ball.velocity;
  const speed = Math.hypot(x, z);
  if (speed === 0) return 0;
  return (ball.spin.x * z - ball.spin.z * x) / speed + 0;
}

/** A standard normal draw from one uniform draw pair (Box–Muller, cosine half). */
function gaussian(random: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}
