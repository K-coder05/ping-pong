import { describe, expect, it } from 'vitest';
import { nextClipName } from './debugMode.ts';

describe('nextClipName', () => {
  it('suggests the first clip, then counts up keeping the zero padding', () => {
    expect(nextClipName(null)).toBe('phone-fore-top-01');
    expect(nextClipName('phone-fore-top-03')).toBe('phone-fore-top-04');
    expect(nextClipName('phone-back-chop-09')).toBe('phone-back-chop-10');
    expect(nextClipName('phone-idle-99')).toBe('phone-idle-100');
    expect(nextClipName('warm-up')).toBe('warm-up-01');
  });
});
