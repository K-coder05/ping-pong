/**
 * Onboarding (SPEC "Onboarding for the prototype"): what a player goes
 * through before the start screen (or, with a developer URL flag, before
 * play starts). A first-time player gets four steps, in order:
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
 * Starting a Match from the start screen (spec P2-h2) needs a Timing Offset:
 * with none saved, Timing calibration runs first (`matchStartSteps`).
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
 * The steps before a Match starts from the start screen: Timing calibration
 * if no Timing Offset is saved (never with the developer mouse, which has no
 * pose latency to calibrate). Return Drill starts straight away.
 */
export function matchStartSteps({ input, timingOffsetSaved }: Omit<OnboardingState, 'handSaved'>): OnboardingStep[] {
  return input === 'pose' && !timingOffsetSaved ? ['calibration'] : [];
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
