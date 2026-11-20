/**
 * The net: whether a ball crossing it clears it, clips its top (a Net-cord),
 * or hits it, and how a Net-cord carries on. Pure; `random` is injected (the
 * game draws it from the Shot's own seed, so look-ahead and the live ball
 * cord identically). Units: m, m/s.
 */

import type { Vec3 } from './vec3.ts';

export type NetContact = 'clear' | 'cord' | 'dead';

/**
 * Share of its x and z speed a Net-cord keeps (a game rule, tuned for feel;
 * fixed, not a knob).
 */
export const NET_CORD_KEEP = 0.3;
/**
 * Most a Net-cord nudges the ball along z, m/s, either way: so a slow ball
 * sometimes trickles over and sometimes drops back (a game rule; fixed).
 */
export const NET_CORD_NUDGE = 0.5;

/** Classify a crossing of z = 0 by the ball's bottom height (centre y − r). */
export function classifyNetCrossing(bottomY: number, netTopY: number, r: number): NetContact {
  if (bottomY >= netTopY) return 'clear';
  if (bottomY >= netTopY - r) return 'cord';
  return 'dead';
}

/**
 * Velocity after a Net-cord. `random` is drawn from the Shot's own seed.
 * It pops up at half its vertical speed and keeps NET_CORD_KEEP of its x and
 * z speed, plus a nudge along z uniform in ±NET_CORD_NUDGE.
 */
export function cordVelocity(velocity: Vec3, random: () => number): Vec3 {
  const nudge = (2 * random() - 1) * NET_CORD_NUDGE;
  return {
    x: NET_CORD_KEEP * velocity.x,
    y: Math.abs(velocity.y) / 2,
    z: NET_CORD_KEEP * velocity.z + nudge * Math.sign(velocity.z),
  };
}
