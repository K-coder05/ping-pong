/**
 * The Streak (SPEC "Scoring"): consecutive Returns, reset by any failed Feed,
 * plus the best Streak this session; and what decides whether a struck ball
 * was a Return.
 */

import type { BallEvent, Vec3 } from './ball.ts';
import { createListeners } from './listeners.ts';

/** How a struck ball's flight was decided. */
export type ReturnFlightResult =
  /** First bounce on the Feeder's half: a Return. */
  | { readonly type: 'return'; readonly position: Readonly<Vec3> }
  /** Into the net, off the table without a bounce, or onto the player's own half first. */
  | { readonly type: 'off-target'; readonly reason: 'net' | 'out' | 'own-half'; readonly position: Readonly<Vec3> };

/**
 * Judge a struck ball from its ball events since launch, in order: a Return
 * if its first bounce is on the Feeder's half; off target if the net, an out
 * or a bounce on the player's half comes first; null while undecided.
 */
export function judgeReturnFlight(events: readonly BallEvent[]): ReturnFlightResult | null {
  for (const event of events) {
    switch (event.type) {
      case 'bounce':
        return event.half === 'feeder'
          ? { type: 'return', position: event.position }
          : { type: 'off-target', reason: 'own-half', position: event.position };
      case 'net':
        return { type: 'off-target', reason: 'net', position: event.position };
      case 'out':
        return { type: 'off-target', reason: 'out', position: event.position };
    }
  }
  return null;
}

export interface StreakState {
  readonly streak: number;
  readonly best: number;
}

export interface Score extends StreakState {
  /** A Return: its first bounce was on the Feeder's half. */
  addReturn(): void;
  /** Any failed Feed: Early, Late, Miss, or a Swing whose ball wasn't a Return. */
  breakStreak(): void;
  /** Called after every change of the Streak or best Streak. Returns an unsubscribe function. */
  subscribe(listener: (state: StreakState) => void): () => void;
}

export function createScore(): Score {
  const listeners = createListeners<StreakState>();
  let streak = 0;
  let best = 0;

  function set(next: number): void {
    if (next === streak) return;
    streak = next;
    best = Math.max(best, streak);
    listeners.emit({ streak, best });
  }

  return {
    get streak() {
      return streak;
    },
    get best() {
      return best;
    },
    addReturn: () => set(streak + 1),
    breakStreak: () => set(0),
    subscribe: listeners.subscribe,
  };
}
