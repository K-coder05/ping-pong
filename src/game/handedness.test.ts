import { describe, expect, it } from 'vitest';
import { createHandednessStore, type KeyValueStorage } from './handedness.ts';

function memoryStorage(): KeyValueStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
}

const brokenStorage: KeyValueStorage = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
};

describe('handedness store', () => {
  it('has no hand until one is chosen', () => {
    expect(createHandednessStore(() => memoryStorage()).hand).toBeNull();
  });

  it('remembers the chosen hand across page loads', () => {
    const storage = memoryStorage();
    createHandednessStore(() => storage).set('left');
    expect(createHandednessStore(() => storage).hand).toBe('left');
  });

  it('ignores a saved value that is not a hand', () => {
    const storage = memoryStorage();
    storage.setItem('returnDrill.hand', 'both');
    expect(createHandednessStore(() => storage).hand).toBeNull();
  });

  it('tells subscribers when the hand changes', () => {
    const store = createHandednessStore(() => memoryStorage());
    const seen: string[] = [];
    const unsubscribe = store.subscribe((hand) => seen.push(hand));
    store.set('left');
    store.set('left');
    store.set('right');
    unsubscribe();
    store.set('left');
    expect(seen).toEqual(['left', 'right']);
  });

  it('still works for this page when storage is blocked or unavailable', () => {
    for (const storage of [() => brokenStorage, () => null]) {
      const store = createHandednessStore(storage);
      expect(store.hand).toBeNull();
      store.set('left');
      expect(store.hand).toBe('left');
    }
  });
});

describe('waiting for the hand to be chosen', () => {
  it('resolves at once with a saved hand', async () => {
    const storage = memoryStorage();
    createHandednessStore(() => storage).set('left');
    await expect(createHandednessStore(() => storage).chosen()).resolves.toBe('left');
  });

  it('resolves when the player first chooses', async () => {
    const store = createHandednessStore(() => memoryStorage());
    let hand: string | null = null;
    void store.chosen().then((chosen) => (hand = chosen));
    await Promise.resolve();
    expect(hand).toBeNull();
    store.set('right');
    await Promise.resolve();
    expect(hand).toBe('right');
  });
});
