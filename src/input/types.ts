/**
 * The input contract between the player and the game. The game only ever
 * consumes `SwingEvent`s, whether they come from the pose Swing detector
 * (`poseInput.ts`) or the developer mouse mode (`?input=mouse`).
 */

/** One Swing, emitted at its Swing Onset (SPEC "The event the game consumes"). */
export interface SwingEvent {
  /** ms timestamp of Swing Onset (camera frame time, `performance.now()` clock). */
  t: number;
  /** Total wrist speed, shoulder widths per second, max over the last 3 frames. */
  peakSpeed: number;
  side: 'forehand' | 'backhand';
  /** Vertical wrist speed at Onset, shoulder widths/s; + = moving upward. Unused until spin is added. */
  vertPath: number;
  /** Face Angle at Swing Onset, radians from Zero; + = closed (toward the floor), − = open. Only the Phone sets it. */
  faceAngle?: number;
}

/** Anything that produces Swings: pose input or mouse input. */
export interface SwingSource {
  /** Called once per Swing Onset. Returns an unsubscribe function. */
  subscribe(listener: (swing: SwingEvent) => void): () => void;
}
