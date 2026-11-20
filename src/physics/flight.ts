/**
 * Forces on a ball in flight, and how its Spin fades. Pure: the caller passes
 * every constant in `FlightParams` (the game builds them from its knobs with
 * `knobFlightParams()` in `game/ball.ts`). Units: m, s, rad/s.
 */

import { add, cross, length, scale, type Vec3 } from './vec3.ts';

export interface FlightParams {
  /** Gravity along y, m/s² (−9.81). */
  g: number;
  /** Drag constant k, /m (≈ 0.14). */
  k: number;
  /** Magnus constant kM: acceleration per (rad/s · m/s) of ω × v. */
  kM: number;
  /** Spin decay time constant τ, s. */
  spinTau: number;
}

/**
 * a = g ŷ − k|v|v + kM (ω × v). Topspin (ω along ŷ × d) pushes the ball down,
 * Backspin lifts it, Sidespin (ω along ŷ) curves it sideways.
 */
export function flightAcceleration(velocity: Vec3, spin: Vec3, p: FlightParams): Vec3 {
  const gravity = { x: 0, y: p.g, z: 0 };
  const drag = scale(velocity, -p.k * length(velocity));
  const magnus = scale(cross(spin, velocity), p.kM);
  return add(add(gravity, drag), magnus);
}

/** ω · e^(−dt/τ): Spin fades exponentially, keeping its axis. */
export function decaySpin(spin: Vec3, dt: number, spinTau: number): Vec3 {
  return scale(spin, Math.exp(-dt / spinTau));
}
