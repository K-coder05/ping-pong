import { handedness } from '../game/handedness.ts';
import type { KnobRegistry } from '../game/knobs.ts';
import { addOverlayExtension } from '../render/cameraOverlay.ts';
import { askHandedness } from '../render/handednessPrompt.ts';
import { createSwingOverlay } from '../render/swingOverlay.ts';
import type { Sensing } from '../sensing/sensing.ts';
import { onSharedSensingStarted } from '../sensing/shared.ts';
import { createPoseInput } from './poseInput.ts';
import type { SwingEvent, SwingSource } from './types.ts';

/** Used until the video reports its size: the 640×480 the camera asks for. */
const DEFAULT_ASPECT = 4 / 3;

/**
 * Adds pose Swing detection to the game page. Once the page's shared sensing
 * starts (debug overlay or game), it asks "Which hand holds the paddle?" if
 * no hand is saved, then turns frames into Swings and adds the stroke-speed
 * bar, Onset flash and CSV columns to the camera overlay. The debug panel's
 * Swing group gets an "Ask handedness" button to change hands.
 *
 * Returns a `SwingSource` usable right away; it emits once sensing has
 * started and the hand is known.
 */
export function installPoseInput(registry: KnobRegistry): SwingSource {
  const listeners = new Set<(swing: SwingEvent) => void>();
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
    input.subscribe((swing) => listeners.forEach((listener) => listener(swing)));
    addOverlayExtension(createSwingOverlay(input));
  }

  onSharedSensingStarted((sensing) => void start(sensing).catch(report));

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
