/**
 * Onboarding (SPEC "Onboarding for the prototype"): what a player goes
 * through before the Return Drill starts. A first-time player gets four
 * steps, in order:
 *
 * 1. `ask-camera`: camera permission, with a line that video stays on the device.
 * 2. `framing`: "Stand back until your whole swing fits in the picture." over the mirrored video.
 * 3. `handedness`: "Which hand holds the paddle?"
 * 4. `calibration`: Timing calibration.
 *
 * A returning player (hand and Timing Offset both saved) only needs the camera
 * on, so it starts without asking (`start-camera`). With the developer mouse
 * (`?input=mouse`) there is no camera to start and no pose latency to
 * calibrate, so there is no onboarding.
 *
 * This module only plans and sequences the steps; the screens are in
 * `render/onboardingScreens.ts`.
 */

export type OnboardingStep = 'ask-camera' | 'start-camera' | 'framing' | 'handedness' | 'calibration';

export interface OnboardingState {
  input: 'pose' | 'mouse';
  handSaved: boolean;
  timingOffsetSaved: boolean;
}

/** The steps a player goes through before the drill, in order. */
export function onboardingSteps({ input, handSaved, timingOffsetSaved }: OnboardingState): OnboardingStep[] {
  if (input === 'mouse') return [];
  if (handSaved && timingOffsetSaved) return ['start-camera'];
  return ['ask-camera', 'framing', ...(handSaved ? [] : ['handedness' as const]), ...(timingOffsetSaved ? [] : ['calibration' as const])];
}

/**
 * What to tell the player when the camera (or the pose model behind it)
 * can't start, from the error `getUserMedia` or the model load rejected with.
 */
export function cameraErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access was blocked. Allow the camera for this page (the camera icon in the address bar), then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found. Connect one, then try again.';
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'The camera is busy, probably in another app. Close that app, then try again.';
  }
  return `The camera couldn't start: ${error instanceof Error ? error.message : String(error)}`;
}

/** Run `steps` one after another; resolves once the last one finishes. */
export async function runOnboarding(
  steps: readonly OnboardingStep[],
  run: Record<OnboardingStep, () => Promise<void>>,
): Promise<void> {
  for (const step of steps) await run[step]();
}
