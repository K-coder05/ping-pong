/**
 * Plain vector helpers for the physics modules. All return new objects and
 * never mutate their inputs. Frame: y up, +z toward the player.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

export function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}
