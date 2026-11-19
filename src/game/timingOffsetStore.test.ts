import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from './handedness.ts';
import { createTimingOffsetStore } from './timingOffsetStore.ts';

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => void (data[key] = value),
  };
}

const throwing: KeyValueStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('Timing Offset store', () => {
  it('has no Timing Offset for a first-time player', () => {
    expect(createTimingOffsetStore(() => memoryStorage()).offsetMs).toBeNull();
  });

  it('remembers a saved Timing Offset across page loads', () => {
    const storage = memoryStorage();
    createTimingOffsetStore(() => storage).save(135);
    expect(createTimingOffsetStore(() => storage).offsetMs).toBe(135);
  });

  it('keeps a negative or zero Timing Offset', () => {
    const storage = memoryStorage();
    createTimingOffsetStore(() => storage).save(-40);
    expect(createTimingOffsetStore(() => storage).offsetMs).toBe(-40);
    createTimingOffsetStore(() => storage).save(0);
    expect(createTimingOffsetStore(() => storage).offsetMs).toBe(0);
  });

  it('ignores a corrupt saved value', () => {
    for (const bad of ['', 'abc', 'NaN', 'Infinity']) {
      const storage = memoryStorage({ 'returnDrill.timingOffsetMs': bad });
      expect(createTimingOffsetStore(() => storage).offsetMs).toBeNull();
    }
  });

  it('still holds the Timing Offset for this page when storage throws', () => {
    const store = createTimingOffsetStore(() => throwing);
    expect(store.offsetMs).toBeNull();
    store.save(120);
    expect(store.offsetMs).toBe(120);
  });

  it('survives storage being unavailable altogether', () => {
    const store = createTimingOffsetStore(() => {
      throw new Error('localStorage is not available');
    });
    store.save(80);
    expect(store.offsetMs).toBe(80);
  });
});
