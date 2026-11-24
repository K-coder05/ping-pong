import { describe, expect, it, vi } from 'vitest';
import { hapticFor, HAPTIC_MS, vibrateFor } from './haptics.ts';

describe('hapticFor', () => {
  it('buzzes 30 ms for an accepted Swing (a Return or a Serve)', () => {
    expect(HAPTIC_MS).toBe(30);
    expect(hapticFor({ type: 'accepted' })).toBe(30);
  });

  it('sends nothing for Early, Late, Miss or anything after the Swing', () => {
    for (const type of ['early', 'late', 'miss', 'contact', 'return', 'off-target'] as const) {
      expect(hapticFor({ type })).toBeNull();
    }
  });
});

describe('vibrateFor', () => {
  it('vibrates for a haptic message', () => {
    const vibrate = vi.fn(() => true);
    vibrateFor({ type: 'haptic', ms: 30 }, { vibrate });
    expect(vibrate).toHaveBeenCalledWith(30);
  });

  it('ignores other messages and skips silently without navigator.vibrate', () => {
    const vibrate = vi.fn(() => true);
    vibrateFor({ type: 'zero' }, { vibrate });
    expect(vibrate).not.toHaveBeenCalled();
    expect(() => vibrateFor({ type: 'haptic', ms: 30 }, {})).not.toThrow();
  });
});
