import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from '../game/handedness.ts';
import type { LinkStatus } from '../phone/types.ts';
import { createInputChoiceStore, INPUT_OPTIONS, inputFromSearch, phoneReadiness } from './inputPicker.ts';

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const data = { ...initial };
  return { getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

describe('the Input picker', () => {
  it('offers only the Camera and the Phone, never the mouse', () => {
    expect(INPUT_OPTIONS.map((o) => o.input)).toEqual(['camera', 'phone']);
    expect(INPUT_OPTIONS.map((o) => o.label)).toEqual(['Camera', 'Phone']);
    expect(JSON.stringify(INPUT_OPTIONS)).not.toMatch(/mouse|controller/i);
  });

  it('is overridden by a developer ?input= flag', () => {
    expect(inputFromSearch('?input=mouse')).toBe('mouse');
    expect(inputFromSearch('?mode=match&input=phone')).toBe('phone');
    expect(inputFromSearch('?input=camera')).toBe('camera');
    expect(inputFromSearch('?input=pose')).toBe('camera');
    expect(inputFromSearch('')).toBeNull();
    expect(inputFromSearch('?input=paddle')).toBeNull();
  });
});

describe('the remembered Input', () => {
  it('has none until the player picks, then remembers the pick across page loads', () => {
    const storage = memoryStorage();
    const store = createInputChoiceStore(() => storage);
    expect(store.input).toBeNull();
    store.save('phone');
    expect(store.input).toBe('phone');
    expect(createInputChoiceStore(() => storage).input).toBe('phone');
  });

  it('never comes back as the mouse, or anything else not offered', () => {
    for (const bad of ['mouse', 'pose', '', 'controller']) {
      expect(createInputChoiceStore(() => memoryStorage({ 'returnDrill.input': bad })).input).toBeNull();
    }
  });

  it('survives localStorage throwing', () => {
    const store = createInputChoiceStore(() => {
      throw new Error('SecurityError');
    });
    expect(store.input).toBeNull();
    expect(() => store.save('camera')).not.toThrow();
    expect(store.input).toBe('camera');
  });
});

describe('Continue with the Phone', () => {
  const ALL: LinkStatus[] = ['idle', 'waiting', 'connecting', 'connected', 'relay', 'disconnected'];

  it('stays disabled until the Phone is connected and Zeroed', () => {
    for (const status of ALL) {
      expect(phoneReadiness({ status, zeroed: false }).canContinue).toBe(false);
      const connected = status === 'connected' || status === 'relay';
      expect(phoneReadiness({ status, zeroed: true }).canContinue).toBe(connected);
    }
  });

  it('locks again if the Phone disconnects', () => {
    expect(phoneReadiness({ status: 'connected', zeroed: true }).canContinue).toBe(true);
    expect(phoneReadiness({ status: 'disconnected', zeroed: true }).canContinue).toBe(false);
  });

  it('says what is missing', () => {
    expect(phoneReadiness({ status: 'waiting', zeroed: false })).toMatchObject({
      connected: false,
      zeroed: false,
      connection: 'Waiting for Phone',
      zeroing: expect.stringMatching(/tap Zero on the Phone/),
    });
    expect(phoneReadiness({ status: 'relay', zeroed: true })).toMatchObject({ connected: true, zeroing: 'Zeroed', connection: 'Connected (relay)' });
  });
});
