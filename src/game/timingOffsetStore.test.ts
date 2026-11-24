import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from './handedness.ts';
import { createTimingOffsetStore, TIMING_OFFSET_KEYS } from './timingOffsetStore.ts';

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
  it('has no Timing Offset for a first-time player, with either Input', () => {
    const store = createTimingOffsetStore(() => memoryStorage());
    expect(store.offsetMsFor('camera')).toBeNull();
    expect(store.offsetMsFor('phone')).toBeNull();
    expect(store.offsetMs).toBeNull();
  });

  it('remembers a saved Timing Offset across page loads', () => {
    const storage = memoryStorage();
    createTimingOffsetStore(() => storage).save('camera', 135);
    expect(createTimingOffsetStore(() => storage).offsetMsFor('camera')).toBe(135);
  });

  it('stores the Camera and the Phone separately', () => {
    const storage = memoryStorage();
    const store = createTimingOffsetStore(() => storage);
    store.save('phone', 40);
    expect(store.offsetMsFor('phone')).toBe(40);
    expect(store.offsetMsFor('camera')).toBeNull();
    store.save('camera', 150);

    const next = createTimingOffsetStore(() => storage);
    expect(next.offsetMsFor('camera')).toBe(150);
    expect(next.offsetMsFor('phone')).toBe(40);
    expect(next.offsetMs).toBe(150); // the Camera's
  });

  it('keeps a Timing Offset saved before there was a Phone as the Camera\'s', () => {
    const storage = memoryStorage({ 'returnDrill.timingOffsetMs': '135' });
    const store = createTimingOffsetStore(() => storage);
    expect(store.offsetMsFor('camera')).toBe(135);
    expect(store.offsetMs).toBe(135);
    expect(store.offsetMsFor('phone')).toBeNull();
    // Saving the Phone's leaves it alone.
    store.save('phone', 20);
    expect(storage.data['returnDrill.timingOffsetMs']).toBe('135');
    expect(createTimingOffsetStore(() => storage).offsetMsFor('camera')).toBe(135);
  });

  it('uses the original key for the Camera and its own for the Phone', () => {
    expect(TIMING_OFFSET_KEYS).toEqual({ camera: 'returnDrill.timingOffsetMs', phone: 'returnDrill.timingOffsetMs.phone' });
  });

  it('keeps a negative or zero Timing Offset', () => {
    const storage = memoryStorage();
    createTimingOffsetStore(() => storage).save('camera', -40);
    expect(createTimingOffsetStore(() => storage).offsetMsFor('camera')).toBe(-40);
    createTimingOffsetStore(() => storage).save('phone', 0);
    expect(createTimingOffsetStore(() => storage).offsetMsFor('phone')).toBe(0);
  });

  it('ignores a corrupt saved value', () => {
    for (const bad of ['', 'abc', 'NaN', 'Infinity']) {
      const storage = memoryStorage({ 'returnDrill.timingOffsetMs': bad, 'returnDrill.timingOffsetMs.phone': bad });
      const store = createTimingOffsetStore(() => storage);
      expect(store.offsetMsFor('camera')).toBeNull();
      expect(store.offsetMsFor('phone')).toBeNull();
    }
  });

  it('still holds the Timing Offset for this page when storage throws', () => {
    const store = createTimingOffsetStore(() => throwing);
    expect(store.offsetMsFor('phone')).toBeNull();
    store.save('phone', 120);
    expect(store.offsetMsFor('phone')).toBe(120);
    expect(store.offsetMsFor('camera')).toBeNull();
  });

  it('survives storage being unavailable altogether', () => {
    const store = createTimingOffsetStore(() => {
      throw new Error('localStorage is not available');
    });
    store.save('camera', 80);
    expect(store.offsetMsFor('camera')).toBe(80);
  });
});
