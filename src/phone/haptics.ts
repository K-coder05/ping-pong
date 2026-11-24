/**
 * Haptics (P3-b §6, P3-e §6): the laptop buzzes the Phone when a Swing is
 * accepted as a Return or a Serve, and the Phone vibrates where the browser
 * allows it.
 */
import type { ShotEvent } from '../game/shotResolver.ts';
import type { ControlMessage } from './types.ts';

/** How long the Phone buzzes for an accepted Swing, ms. */
export const HAPTIC_MS = 30;

/**
 * The buzz for a resolver event: `HAPTIC_MS` when a Swing was accepted (a
 * Return, or at a toss a Serve), null for Early, Late, Miss and everything else.
 */
export function hapticFor(event: Pick<ShotEvent, 'type'>): number | null {
  return event.type === 'accepted' ? HAPTIC_MS : null;
}

/** Phone side: vibrate for a `haptic` control message. Skips silently where there is no `navigator.vibrate` (iOS Safari). */
export function vibrateFor(m: ControlMessage, nav: { vibrate?: (ms: number) => boolean }): void {
  if (m.type === 'haptic' && typeof nav.vibrate === 'function') nav.vibrate(m.ms);
}
