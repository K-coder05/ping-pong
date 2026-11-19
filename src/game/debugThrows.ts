import { launchBall, type BallState } from './ball.ts';
import { BALL_RADIUS, TABLE_TOP_Y } from './constants.ts';

/** Hand-made launches behind the debug panel's ball buttons (the ball-physics checkpoint). */
export const DEBUG_THROWS = {
  /** Dropped from rest with its bottom 30 cm above the player's half: should bounce to about 23 cm. */
  drop: (): BallState => launchBall({ x: 0, y: TABLE_TOP_Y + BALL_RADIUS + 0.3, z: 0.7 }, { x: 0, y: 0, z: 0 }),
  /** Low and fast from the player's half toward the Feeder: reaches z = 0 below net height. */
  intoNet: (): BallState => launchBall({ x: 0.2, y: TABLE_TOP_Y + 0.08, z: 0.6 }, { x: 0, y: 0.4, z: -6 }),
  /** Sideways off the player's half, past the side line without touching the table. */
  offTable: (): BallState => launchBall({ x: 0, y: TABLE_TOP_Y + 0.3, z: 0.6 }, { x: 5, y: 1, z: 0 }),
} as const;
