/**
 * Whether play waits for the player's hand, and what the banner says, for
 * every Input (SPEC "Tracking loss"; docs/specs/p3.md, P3-e §2). The game
 * reads it every frame: while `waiting`, the core is paused (no new Feed or
 * Serve, Swings ignored, a Match Rally in progress void and served again
 * after the "3, 2, 1" once resumed), and `banner`, if any, shows over play.
 *
 * - Camera: waits until the hitting wrist is tracked; "Can't see your hand"
 *   once it has been lost.
 * - Phone: waits while it isn't sending (not yet Zeroed, or a short gap) or
 *   is away (`phone/presence.ts`: its page locked, went to the background or
 *   reloaded); "Phone disconnected: unlock your phone" while away.
 * - The developer mouse never waits.
 */
import type { HandTracking } from '../input/installPoseInput.ts';

export const HAND_LOST_TEXT = "Can't see your hand";
export const PHONE_AWAY_TEXT = 'Phone disconnected: unlock your phone';

export type HandSignals =
  | { input: 'camera'; tracking: HandTracking }
  /** `sending`: the Phone Input has a live hand position; `away`: the Phone's presence. */
  | { input: 'phone'; sending: boolean; away: boolean }
  | { input: 'mouse' };

export interface HandPause {
  waiting: boolean;
  banner: string | null;
}

export function handPause(s: HandSignals): HandPause {
  switch (s.input) {
    case 'camera':
      return { waiting: s.tracking !== 'tracked', banner: s.tracking === 'lost' ? HAND_LOST_TEXT : null };
    case 'phone':
      return { waiting: !s.sending || s.away, banner: s.away ? PHONE_AWAY_TEXT : null };
    case 'mouse':
      return { waiting: false, banner: null };
  }
}
