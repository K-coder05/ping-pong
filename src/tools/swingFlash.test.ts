import { describe, expect, it } from 'vitest';
import type { SwingEvent } from '../input/types.ts';
import { createSwingFlash, FLASH_MS } from './swingFlash.ts';

const swing = (t: number): SwingEvent => ({ t, peakSpeed: 5, side: 'forehand', vertPath: 0 });

describe('createSwingFlash', () => {
  it('is off before any Swing', () => {
    const flash = createSwingFlash();
    expect(flash.isOn(0)).toBe(false);
    expect(flash.offAt).toBeNull();
    expect(flash.swings).toBe(0);
    expect(flash.lastDetectMs).toBeNull();
  });

  it('goes on the instant a Swing Onset is detected, and off FLASH_MS later', () => {
    const flash = createSwingFlash();
    flash.onset(swing(980), 1000);
    expect(flash.isOn(999)).toBe(false);
    expect(flash.isOn(1000)).toBe(true);
    expect(flash.isOn(1000 + FLASH_MS - 1)).toBe(true);
    expect(flash.isOn(1000 + FLASH_MS)).toBe(false);
    expect(flash.offAt).toBe(1000 + FLASH_MS);
  });

  it("times the flash from detection, not from the Swing's own Onset time", () => {
    // A Camera Swing stamped with its frame's capture time, recognised 120 ms later.
    const flash = createSwingFlash(100);
    flash.onset(swing(5000), 5120);
    expect(flash.isOn(5110)).toBe(false);
    expect(flash.isOn(5120)).toBe(true);
    expect(flash.isOn(5219)).toBe(true);
    expect(flash.isOn(5220)).toBe(false);
    expect(flash.lastDetectMs).toBe(120);
  });

  it('starts over on a Swing during a flash', () => {
    const flash = createSwingFlash(100);
    flash.onset(swing(0), 0);
    flash.onset(swing(60), 80);
    expect(flash.isOn(150)).toBe(true);
    expect(flash.isOn(180)).toBe(false);
    expect(flash.swings).toBe(2);
    expect(flash.lastDetectMs).toBe(20);
  });

  it('flashes again for a later Swing', () => {
    const flash = createSwingFlash(100);
    flash.onset(swing(0), 0);
    expect(flash.isOn(500)).toBe(false);
    flash.onset(swing(995), 1000);
    expect(flash.isOn(1000)).toBe(true);
    expect(flash.lastDetectMs).toBe(5);
  });
});
