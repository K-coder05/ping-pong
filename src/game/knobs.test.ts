import { describe, expect, it } from 'vitest';
import { createKnobRegistry } from './knobs.ts';

describe('knob registry', () => {
  it('a registered number knob reads its default as its live value', () => {
    const knobs = createKnobRegistry();
    const hitWindow = knobs.number({ name: 'HIT_WINDOW_MS', min: 50, max: 400, step: 10, default: 200 });
    expect(hitWindow.value).toBe(200);
  });

  it('setting a number knob changes the live value seen by readers', () => {
    const knobs = createKnobRegistry();
    const timeScale = knobs.number({ name: 'TIME_SCALE', min: 0.3, max: 1, step: 0.05, default: 0.8 });
    timeScale.set(0.9);
    expect(timeScale.value).toBe(0.9);
  });

  it('clamps set values to the knob range', () => {
    const knobs = createKnobRegistry();
    const timeScale = knobs.number({ name: 'TIME_SCALE', min: 0.3, max: 1, step: 0.05, default: 0.8 });
    timeScale.set(5);
    expect(timeScale.value).toBe(1);
    timeScale.set(-2);
    expect(timeScale.value).toBe(0.3);
  });

  it('snaps set values to the step grid without float noise', () => {
    const knobs = createKnobRegistry();
    const timeScale = knobs.number({ name: 'TIME_SCALE', min: 0.3, max: 1, step: 0.05, default: 0.8 });
    timeScale.set(0.62);
    expect(timeScale.value).toBe(0.6);
    timeScale.set(0.63);
    expect(timeScale.value).toBe(0.65);
  });

  it('rejects a second knob with the same name', () => {
    const knobs = createKnobRegistry();
    knobs.number({ name: 'SWING_ON', min: 1, max: 6, step: 0.1, default: 3 });
    expect(() => knobs.toggle({ name: 'SWING_ON', default: true })).toThrow(/SWING_ON/);
  });

  it.each([
    ['default below min', { min: 1, max: 6, step: 0.1, default: 0.5 }],
    ['default above max', { min: 1, max: 6, step: 0.1, default: 7 }],
    ['default off the step grid', { min: 1, max: 6, step: 0.5, default: 3.2 }],
    ['min not below max', { min: 6, max: 6, step: 0.1, default: 6 }],
    ['non-positive step', { min: 1, max: 6, step: 0, default: 3 }],
  ])('rejects a number knob with %s', (_case, range) => {
    const knobs = createKnobRegistry();
    expect(() => knobs.number({ name: 'SWING_ON', ...range })).toThrow(/SWING_ON/);
  });

  it('a toggle knob reads its default and can be flipped', () => {
    const knobs = createKnobRegistry();
    const contactAssist = knobs.toggle({ name: 'CONTACT_ASSIST', default: true });
    expect(contactAssist.value).toBe(true);
    contactAssist.set(false);
    expect(contactAssist.value).toBe(false);
  });

  it('a button runs its debug action when pressed', () => {
    const knobs = createKnobRegistry();
    let drops = 0;
    const dropBall = knobs.button({ name: 'Drop ball', onPress: () => drops++ });
    dropBall.press();
    dropBall.press();
    expect(drops).toBe(2);
  });

  it('lists every entry in registration order with its kind and group', () => {
    const knobs = createKnobRegistry();
    knobs.number({ name: 'SWING_ON', min: 1, max: 6, step: 0.1, default: 3, group: 'Swing' });
    knobs.toggle({ name: 'CONTACT_ASSIST', default: true, group: 'Paddle' });
    knobs.button({ name: 'Drop ball', onPress: () => {} });
    expect(knobs.entries().map((e) => [e.kind, e.name, e.group])).toEqual([
      ['number', 'SWING_ON', 'Swing'],
      ['toggle', 'CONTACT_ASSIST', 'Paddle'],
      ['button', 'Drop ball', 'General'],
    ]);
  });

  it('tells listeners about entries registered after they subscribed', () => {
    const knobs = createKnobRegistry();
    knobs.number({ name: 'SWING_ON', min: 1, max: 6, step: 0.1, default: 3 });
    const seen: string[] = [];
    knobs.onRegister((entry) => seen.push(entry.name));
    knobs.toggle({ name: 'CONTACT_ASSIST', default: true });
    expect(seen).toEqual(['CONTACT_ASSIST']);
  });

  it('tells listeners when a knob value changes, but not when it is set to the same value', () => {
    const knobs = createKnobRegistry();
    const swingOn = knobs.number({ name: 'SWING_ON', min: 1, max: 6, step: 0.1, default: 3 });
    const contactAssist = knobs.toggle({ name: 'CONTACT_ASSIST', default: true });
    const changes: [string, number | boolean][] = [];
    const unsubscribe = knobs.onChange((entry) => changes.push([entry.name, entry.value]));
    swingOn.set(3.5);
    swingOn.set(3.5);
    contactAssist.set(false);
    unsubscribe();
    swingOn.set(4);
    expect(changes).toEqual([
      ['SWING_ON', 3.5],
      ['CONTACT_ASSIST', false],
    ]);
  });

  it('reset restores every knob to its default', () => {
    const knobs = createKnobRegistry();
    const swingOn = knobs.number({ name: 'SWING_ON', min: 1, max: 6, step: 0.1, default: 3 });
    const contactAssist = knobs.toggle({ name: 'CONTACT_ASSIST', default: true });
    swingOn.set(5);
    contactAssist.set(false);
    knobs.resetAll();
    expect(swingOn.value).toBe(3);
    expect(contactAssist.value).toBe(true);
  });

  it('accepts a default on a fractional step grid despite float noise', () => {
    const knobs = createKnobRegistry();
    expect(() => knobs.number({ name: 'K', min: 0.3, max: 1, step: 0.05, default: 0.8 })).not.toThrow();
  });
});
