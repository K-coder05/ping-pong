import { describe, expect, it } from 'vitest';
import { phoneStep } from './toolPhone.ts';

describe('phoneStep', () => {
  it('asks to pair until the Phone is connected', () => {
    for (const status of ['idle', 'waiting', 'connecting', 'disconnected'] as const) expect(phoneStep(status, false)).toBe('pair');
    // A Phone that drops keeps no Swings coming, whatever arrived last.
    expect(phoneStep('disconnected', true)).toBe('pair');
  });

  it('asks for Zeroing once connected, until the Phone is Zeroed and sending', () => {
    expect(phoneStep('connected', false)).toBe('zero');
    expect(phoneStep('relay', false)).toBe('zero');
    expect(phoneStep('connected', true)).toBe('ready');
    expect(phoneStep('relay', true)).toBe('ready');
  });
});
