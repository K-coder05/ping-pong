import type { SwingEvent, SwingSource } from './types.ts';

/**
 * A `SwingSource` you push Swings into, for any input (pose, mouse) to
 * build on. One failing listener never stops the others.
 */
export function createSwingEmitter(): SwingSource & { emit(swing: SwingEvent): void } {
  const listeners = new Set<(swing: SwingEvent) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit(swing) {
      for (const listener of listeners) {
        try {
          listener(swing);
        } catch (error) {
          console.error('Swing listener failed', error);
        }
      }
    },
  };
}
