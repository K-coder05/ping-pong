import { handedness } from '../game/handedness.ts';
import type { KnobRegistry } from '../game/knobs.ts';
import { addOverlayExtension } from '../render/cameraOverlay.ts';
import { askHandedness } from '../render/handednessPrompt.ts';
import { createSwingOverlay } from '../render/swingOverlay.ts';
import type { Sensing } from '../sensing/sensing.ts';
import { onSharedSensingStarted, sharedSensing } from '../sensing/shared.ts';
import type { HandPositionSource } from './handPosition.ts';
import { createPoseHand, type PoseHand } from './poseHand.ts';
import { createPoseInput } from './poseInput.ts';
import { createSwingEmitter } from './swingEmitter.ts';
import type { SwingSource } from './types.ts';

/** Used until the video reports its size: the 640×480 the camera asks for. */
const DEFAULT_ASPECT = 4 / 3;

/**
 * Whether play can see the player's hitting hand: `starting` until the
 * camera is on and the hitting hand is known, then `tracked` or `lost`
 * (SPEC "Tracking loss").
 */
export type HandTracking = 'starting' | 'tracked' | 'lost';

/** Pose input for the game: Swings, the wrist the Paddle follows, and whether it can be seen. */
export interface InstalledPoseInput extends SwingSource, HandPositionSource {
  readonly tracking: HandTracking;
}

/**
 * Start the camera (permission prompt, pose model download) so the player can
 * play with their hand. This is the one place play starts it; the debug
 * overlay may start the same shared sensing sooner. Rejects if the camera or
 * model can't start (e.g. permission denied); calling again retries.
 */
export function startCamera(): Promise<void> {
  return sharedSensing().then(() => undefined);
}

/**
 * Adds pose input to the game page. Once the page's shared sensing starts
 * (`startCamera`, or the debug overlay), it asks "Which hand holds the
 * paddle?" if no hand is saved, then turns frames into Swings, tracks the
 * hitting wrist for the Paddle and tracking loss, and adds the stroke-speed
 * bar, Onset flash and CSV columns to the camera overlay. The debug panel's
 * Swing group gets an "Ask handedness" button to change hands.
 *
 * Returns right away; it emits Swings and has a wrist position once sensing
 * has started and the hand is known, and only while the wrist is tracked.
 * It never starts the camera itself.
 */
export function installPoseInput(registry: KnobRegistry): InstalledPoseInput {
  const swings = createSwingEmitter();
  /** The tracked hitting wrist, once sensing has started and the hand is known. */
  let poseHand: PoseHand | null = null;
  const report = (error: unknown) => console.error('Handedness prompt failed', error);

  registry.button({
    name: 'Ask handedness',
    group: 'Swing',
    onPress: () => void askHandedness().then((hand) => handedness.set(hand), report),
  });

  async function start(sensing: Sensing): Promise<void> {
    handedness.subscribe((hand) => sensing.setHand(hand));
    const hand = handedness.hand ?? (await askHandedness());
    handedness.set(hand);
    sensing.setHand(hand); // in case the saved hand was already set before subscribing

    const input = createPoseInput(sensing, {
      aspect: () => {
        const { videoWidth, videoHeight } = sensing.video;
        return videoWidth && videoHeight ? videoWidth / videoHeight : DEFAULT_ASPECT;
      },
    });
    poseHand = createPoseHand(sensing, input);
    // While the wrist is lost its position is a guess, so a "Swing" from it
    // could Return a Feed the player never hit. (Tracking is as of the
    // previous frame here; loss itself takes several frames to call.)
    input.subscribe((swing) => {
      if (poseHand?.tracked) swings.emit(swing);
    });
    addOverlayExtension(createSwingOverlay(input));
  }

  onSharedSensingStarted((sensing) => void start(sensing).catch(report));

  return {
    subscribe: swings.subscribe,
    get latest() {
      return poseHand?.latest ?? null;
    },
    get tracking() {
      if (!poseHand) return 'starting';
      return poseHand.tracked ? 'tracked' : 'lost';
    },
  };
}
