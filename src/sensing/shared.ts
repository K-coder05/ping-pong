import type { Sensing } from './sensing.ts';

/**
 * The game page's one sensing instance, so the debug overlay and the game
 * open the camera once. This module is light: MediaPipe is only downloaded
 * when sensing first starts.
 *
 * The shared instance lives for the page: don't call `stop()` on it.
 */

let shared: Promise<Sensing> | null = null;
let started: Sensing | null = null;
const startListeners = new Set<(sensing: Sensing) => void>();

/**
 * Starts sensing on first call (camera permission prompt, model download)
 * and returns the same instance afterwards. If starting fails (e.g.
 * permission denied), the next call tries again.
 */
export function sharedSensing(): Promise<Sensing> {
  shared ??= import('./sensing.ts')
    .then(({ startSensing }) => startSensing())
    .then((sensing) => {
      started = sensing;
      for (const listener of startListeners) listener(sensing);
      return sensing;
    })
    .catch((error: unknown) => {
      shared = null;
      throw error;
    });
  return shared;
}

/**
 * Calls `listener` once shared sensing has started, whoever starts it
 * (immediately if it already has). Returns an unsubscribe function.
 */
export function onSharedSensingStarted(listener: (sensing: Sensing) => void): () => void {
  startListeners.add(listener);
  if (started) listener(started);
  return () => void startListeners.delete(listener);
}
