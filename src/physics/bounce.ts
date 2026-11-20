/**
 * The table bounce: a contact model that trades the ball's speed for its Spin,
 * so Topspin kicks forward and low and Backspin comes off no faster (slower on
 * steep bounces). Pure: the caller passes every constant in `BounceParams`
 * (the game builds them with `knobBounceParams()` in `game/ball.ts`).
 * Units: m, m/s, rad/s.
 *
 * Model (spec P1-b, after Sony AI's 2026 table tennis physics paper), with the
 * table normal n = +y and u the contact point's slip velocity:
 *
 *   u = v_T − r(ω × n),  α = min(2/5, µ(1+e)|v_y| / |u|)
 *   v_T⁺ = v_T − αu,  v_y⁺ = −e·v_y,  ω⁺ = ω + (κα/r)(n × u)
 *
 * α = 2/5 = 1/(1+κ) is exactly the rolling limit: the ball leaves rolling.
 * Below it the ball slides through the whole contact and loses the same
 * impulse µ(1+e)|v_y| whatever its spin, so Backspin only comes off slower
 * than no spin when the no-spin ball would have reached rolling. Using the
 * slip velocity (not the paper's tangential velocity) in α is a deliberate
 * simplification.
 */

import { add, cross, length, scale, sub, type Vec3 } from './vec3.ts';

export interface BounceParams {
  /** Restitution of the vertical speed (0.88). */
  e: number;
  /** Ball–table friction coefficient µ (knob TABLE_MU, 0.25). */
  mu: number;
  /** κ = mr²/I: 3/2 for a thin spherical shell. */
  kappa: number;
  /** Ball radius, m (0.020). */
  r: number;
}

const UP: Vec3 = { x: 0, y: 1, z: 0 };
/** Below this slip speed (m/s) the ball is already rolling: no friction. */
const MIN_SLIP = 1e-9;

/** Ball touching a horizontal surface with normal +y and v.y < 0. Returns the outgoing velocity and spin. */
export function tableBounce(velocity: Vec3, spin: Vec3, p: BounceParams): { velocity: Vec3; spin: Vec3 } {
  const vT: Vec3 = { x: velocity.x, y: 0, z: velocity.z };
  const vy = -p.e * velocity.y;

  // ω × n is horizontal for n = +y, so u is too.
  const u = sub(vT, scale(cross(spin, UP), p.r));
  const slip = length(u);
  if (slip < MIN_SLIP) return { velocity: { ...vT, y: vy }, spin: { ...spin } };

  const alpha = Math.min(2 / 5, (p.mu * (1 + p.e) * Math.abs(velocity.y)) / slip);
  const outT = sub(vT, scale(u, alpha));
  return {
    velocity: { x: outT.x, y: vy, z: outT.z },
    spin: add(spin, scale(cross(UP, u), (p.kappa * alpha) / p.r)),
  };
}
