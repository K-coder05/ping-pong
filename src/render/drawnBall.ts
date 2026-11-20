import type { Vec3 } from '../game/ball.ts';
import { BALL_RADIUS } from '../game/constants.ts';

/**
 * Where the ball is drawn: `BALL_DRAW_SCALE` times its physics radius, lifted
 * so its bottom sits where the physics ball's bottom is (it then visibly
 * touches the table at each bounce).
 */
export function drawnBall(position: Readonly<Vec3>, drawScale: number): { centre: Vec3; radius: number } {
  return {
    centre: { x: position.x, y: position.y + BALL_RADIUS * (drawScale - 1), z: position.z },
    radius: BALL_RADIUS * drawScale,
  };
}

/** Real spin (rad/s) at which the drawn rate reaches about 76% of SPIN_DRAW_MAX_REVS: 30 rev/s. */
const SPIN_DRAW_KNEE_RAD_PER_S = 2 * Math.PI * 30;

/**
 * How fast the ball's stripe turns on screen, in rev/s, for a real spin
 * vector `spin` (rad/s): `maxRevs × tanh(|ω| / (2π · 30))`. Monotonic in the
 * real rate, zero for no spin, and never above `maxRevs` (pass SPIN_DRAW_MAX_REVS).
 */
export function drawnSpinRate(spin: Readonly<Vec3>, maxRevs: number): number {
  return maxRevs * Math.tanh(Math.hypot(spin.x, spin.y, spin.z) / SPIN_DRAW_KNEE_RAD_PER_S);
}
