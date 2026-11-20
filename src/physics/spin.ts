/**
 * Spin vectors in rad/s, in the project frame (y up, +z toward the player).
 * Topspin on a Shot toward the Feeder (-z) points along -x, so the Magnus
 * force pushes the ball down; Sidespin points along y.
 */

import { cross, scale, add, type Vec3 } from './vec3.ts';

const UP: Vec3 = { x: 0, y: 1, z: 0 };

/** d = unit vector along the Shot's horizontal direction of travel. Spins in rad/s. */
export function spinVector(topspin: number, sidespin: number, d: Vec3): Vec3 {
  const v = add(scale(cross(UP, d), topspin), scale(UP, sidespin));
  // Normalise -0 (e.g. 0 * -1) so zero spin is exactly the zero vector.
  return { x: v.x + 0, y: v.y + 0, z: v.z + 0 };
}

export const revsToRadPerSec = (revs: number): number => revs * 2 * Math.PI;
