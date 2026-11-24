import type { KeyValueStorage } from './handedness.ts';

/**
 * Onboarding (SPEC "Onboarding for the prototype"; docs/specs/p3.md, P3-e):
 * what a player goes through before the start screen (or, with a developer
 * URL flag, before play starts). It depends on the Input.
 *
 * With the Camera, a first-time player gets four steps, in order:
 *
 * 1. `ask-camera`: camera permission, with a line that video stays on the device.
 * 2. `framing`: "Stand back until your whole swing fits in the picture." over the mirrored video.
 * 3. `handedness`: "Which hand holds the paddle?"
 * 4. `calibration`: Timing calibration.
 *
 * A returning Camera player (hand and Timing Offset both saved) only needs
 * the camera on, so it starts without asking (`start-camera`).
 *
 * With the Phone there is no camera and no framing. Instead:
 *
 * 1. `phone-safety`, the first time only: grip firmly, a wrist strap or
 *    lanyard case, clear space ("Got it" is remembered, `phoneSafetyStore`).
 * 2. `phone-pairing`: the QR code, the room code and the connection status.
 * 3. `handedness`, if not saved (the same setting as the Camera's).
 * 4. `phone-zeroing`: tap Zero on the Phone.
 * 5. `calibration`, if no Timing Offset is saved for the Phone.
 * 6. `phone-ready`: Continue, which unlocks once the Phone is connected and Zeroed.
 *
 * With the developer mouse (`?input=mouse`) there is no camera to start and
 * no latency to calibrate, so there is no onboarding.
 *
 * Starting a Match from the start screen (spec P2-h2) needs a Timing Offset:
 * with none saved for the Input, Timing calibration runs first (`matchStartSteps`).
 *
 * This module only plans and sequences the steps; the screens are in
 * `render/onboardingScreens.ts`.
 */

/** An Input offered to players (GLOSSARY "Input"). */
export type Input = 'camera' | 'phone';

/** What play swings with: an Input, or the developer mouse (`?input=mouse`, never offered to players). */
export type InputMode = Input | 'mouse';

export type OnboardingStep =
  | 'ask-camera'
  | 'start-camera'
  | 'framing'
  | 'handedness'
  | 'calibration'
  | 'phone-safety'
  | 'phone-pairing'
  | 'phone-zeroing'
  | 'phone-ready';

export interface OnboardingState {
  input: InputMode;
  handSaved: boolean;
  /** Whether a Timing Offset is saved for this Input. */
  timingOffsetSaved: boolean;
  /** Phone only: whether the player has tapped "Got it" on the safety prompt before. Default false. */
  phoneSafetySeen?: boolean;
}

/** The steps a player goes through before the drill, in order. */
export function onboardingSteps({ input, handSaved, timingOffsetSaved, phoneSafetySeen = false }: OnboardingState): OnboardingStep[] {
  const hand: OnboardingStep[] = handSaved ? [] : ['handedness'];
  const calibration: OnboardingStep[] = timingOffsetSaved ? [] : ['calibration'];
  switch (input) {
    case 'mouse':
      return [];
    case 'phone':
      return [...(phoneSafetySeen ? [] : (['phone-safety'] as const)), 'phone-pairing', ...hand, 'phone-zeroing', ...calibration, 'phone-ready'];
    case 'camera':
      if (handSaved && timingOffsetSaved) return ['start-camera'];
      return ['ask-camera', 'framing', ...hand, ...calibration];
  }
}

/**
 * The steps before a Match starts from the start screen: Timing calibration
 * if no Timing Offset is saved for the Input (never with the developer
 * mouse, which has no latency to calibrate). Return Drill starts straight away.
 */
export function matchStartSteps({ input, timingOffsetSaved }: Pick<OnboardingState, 'input' | 'timingOffsetSaved'>): OnboardingStep[] {
  return input !== 'mouse' && !timingOffsetSaved ? ['calibration'] : [];
}

/** Whether the player has seen the Phone's safety prompt, remembered in `localStorage`. */
export interface PhoneSafetyStore {
  /** Whether they tapped "Got it" (on this page, or saved from an earlier visit). */
  readonly seen: boolean;
  /** They tapped "Got it": remember it. */
  acknowledge(): void;
}

const PHONE_SAFETY_KEY = 'returnDrill.phoneSafetySeen';

/**
 * `storage` is a getter because merely reading `window.localStorage` can
 * throw. Every access is guarded: if storage fails, the prompt shows again
 * next visit, and "Got it" still holds for this page.
 */
export function createPhoneSafetyStore(storage: () => KeyValueStorage | null): PhoneSafetyStore {
  let seen = load();

  function load(): boolean {
    try {
      return storage()?.getItem(PHONE_SAFETY_KEY) === '1';
    } catch {
      return false;
    }
  }

  return {
    get seen() {
      return seen;
    },
    acknowledge() {
      seen = true;
      try {
        storage()?.setItem(PHONE_SAFETY_KEY, '1');
      } catch {
        // Not saved; the prompt shows again next visit.
      }
    },
  };
}

/** The page's Phone safety prompt, remembered in `localStorage`. */
export const phoneSafetyStore: PhoneSafetyStore = createPhoneSafetyStore(() =>
  typeof window === 'undefined' ? null : window.localStorage,
);

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
