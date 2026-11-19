import { createListeners } from '../game/listeners.ts';
import type { SwingEvent, SwingSource } from './types.ts';

/**
 * A `SwingSource` you push Swings into, for any input (pose, mouse) to
 * build on. One failing listener never stops the others.
 */
export function createSwingEmitter(): SwingSource & { emit(swing: SwingEvent): void } {
  return createListeners<SwingEvent>();
}
