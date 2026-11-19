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
