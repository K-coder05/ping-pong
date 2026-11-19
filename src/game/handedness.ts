import type { Hand } from '../sensing/landmarks.ts';

/**
 * The player's hitting hand ("Which hand holds the paddle?"), asked once and
 * remembered in `localStorage` (SPEC "Swing detection"). Storage can throw
 * (private mode, blocked site data), so every access is guarded and the
 * choice still holds for the current page when it can't be saved.
 *
 * Asking is UI (`render/handednessPrompt.ts`); this module only stores.
 */

/** The part of `Storage` this module uses. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface HandednessStore {
  /** The chosen hand, or null if the player hasn't been asked yet. */
  readonly hand: Hand | null;
  /** Choose (and save) the hand; tells subscribers if it changed. */
  set(hand: Hand): void;
  /** Called with each new hand. Returns an unsubscribe function. */
  subscribe(listener: (hand: Hand) => void): () => void;
}

const STORAGE_KEY = 'returnDrill.hand';

/** `storage` is a getter because merely reading `window.localStorage` can throw. */
export function createHandednessStore(storage: () => KeyValueStorage | null): HandednessStore {
  const listeners = new Set<(hand: Hand) => void>();
  let hand = load();

  function load(): Hand | null {
    try {
      const saved = storage()?.getItem(STORAGE_KEY);
      return saved === 'left' || saved === 'right' ? saved : null;
    } catch {
      return null;
    }
  }

  return {
    get hand() {
      return hand;
    },
    set(next) {
      try {
        storage()?.setItem(STORAGE_KEY, next);
      } catch {
        // Not saved; it still applies until the page reloads.
      }
      if (next === hand) return;
      hand = next;
      for (const listener of listeners) listener(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The page's handedness, saved in `localStorage`. */
export const handedness: HandednessStore = createHandednessStore(() => (typeof window === 'undefined' ? null : window.localStorage));
