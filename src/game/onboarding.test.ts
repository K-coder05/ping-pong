import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from './handedness.ts';
import {
  cameraErrorMessage,
  createPhoneSafetyStore,
  matchStartSteps,
  onboardingSteps,
  runOnboarding,
  type OnboardingStep,
} from './onboarding.ts';

describe('onboardingSteps', () => {
  it('takes a first-time player through camera, framing, handedness and Timing calibration, in order', () => {
    expect(onboardingSteps({ input: 'camera', handSaved: false, timingOffsetSaved: false })).toEqual([
      'ask-camera',
      'framing',
      'handedness',
      'calibration',
    ]);
  });

  it('sends a returning player straight to the drill once the camera starts', () => {
    expect(onboardingSteps({ input: 'camera', handSaved: true, timingOffsetSaved: true })).toEqual(['start-camera']);
  });

  it('only asks for what is missing, with the framing instruction before it', () => {
    expect(onboardingSteps({ input: 'camera', handSaved: true, timingOffsetSaved: false })).toEqual([
      'ask-camera',
      'framing',
      'calibration',
    ]);
    expect(onboardingSteps({ input: 'camera', handSaved: false, timingOffsetSaved: true })).toEqual([
      'ask-camera',
      'framing',
      'handedness',
    ]);
  });

  it('skips onboarding with the developer mouse', () => {
    expect(onboardingSteps({ input: 'mouse', handSaved: false, timingOffsetSaved: false })).toEqual([]);
  });
});

describe('onboardingSteps with the Phone', () => {
  const CAMERA_ONLY: OnboardingStep[] = ['ask-camera', 'start-camera', 'framing'];

  it('takes a first-time player through safety, pairing, handedness, Zeroing, Timing calibration and Continue, in order', () => {
    expect(onboardingSteps({ input: 'phone', handSaved: false, timingOffsetSaved: false, phoneSafetySeen: false })).toEqual([
      'phone-safety',
      'phone-pairing',
      'handedness',
      'phone-zeroing',
      'calibration',
      'phone-ready',
    ]);
  });

  it('asks for the hand only if it is not saved, and calibrates only without a Phone Timing Offset', () => {
    expect(onboardingSteps({ input: 'phone', handSaved: true, timingOffsetSaved: false, phoneSafetySeen: true })).toEqual([
      'phone-pairing',
      'phone-zeroing',
      'calibration',
      'phone-ready',
    ]);
    expect(onboardingSteps({ input: 'phone', handSaved: false, timingOffsetSaved: true, phoneSafetySeen: true })).toEqual([
      'phone-pairing',
      'handedness',
      'phone-zeroing',
      'phone-ready',
    ]);
  });

  it('still pairs, Zeroes and waits for Continue for a returning player', () => {
    expect(onboardingSteps({ input: 'phone', handSaved: true, timingOffsetSaved: true, phoneSafetySeen: true })).toEqual([
      'phone-pairing',
      'phone-zeroing',
      'phone-ready',
    ]);
  });

  it('shows the safety prompt only until the player has seen it', () => {
    expect(onboardingSteps({ input: 'phone', handSaved: true, timingOffsetSaved: true })[0]).toBe('phone-safety');
    expect(onboardingSteps({ input: 'phone', handSaved: true, timingOffsetSaved: true, phoneSafetySeen: true })).not.toContain('phone-safety');
  });

  it('never has a camera or framing step', () => {
    for (const handSaved of [false, true]) {
      for (const timingOffsetSaved of [false, true]) {
        for (const phoneSafetySeen of [false, true]) {
          const steps = onboardingSteps({ input: 'phone', handSaved, timingOffsetSaved, phoneSafetySeen });
          expect(steps.filter((s) => CAMERA_ONLY.includes(s))).toEqual([]);
        }
      }
    }
  });

  it('leaves the Camera without any Phone step', () => {
    for (const handSaved of [false, true]) {
      for (const timingOffsetSaved of [false, true]) {
        expect(onboardingSteps({ input: 'camera', handSaved, timingOffsetSaved, phoneSafetySeen: false }).some((s) => s.startsWith('phone-'))).toBe(false);
      }
    }
  });
});

describe('the Phone safety prompt store', () => {
  function memoryStorage(): KeyValueStorage {
    const data: Record<string, string> = {};
    return { getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
  }

  it('shows the first time only: "Got it" is remembered across page loads', () => {
    const storage = memoryStorage();
    const first = createPhoneSafetyStore(() => storage);
    expect(first.seen).toBe(false);
    first.acknowledge();
    expect(first.seen).toBe(true);
    expect(createPhoneSafetyStore(() => storage).seen).toBe(true);
  });

  it('survives localStorage throwing: the prompt shows, and "Got it" holds for this page', () => {
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const store = createPhoneSafetyStore(() => throwing);
    expect(store.seen).toBe(false);
    expect(() => store.acknowledge()).not.toThrow();
    expect(store.seen).toBe(true);

    const unavailable = createPhoneSafetyStore(() => {
      throw new Error('localStorage is not available');
    });
    expect(unavailable.seen).toBe(false);
    expect(() => unavailable.acknowledge()).not.toThrow();
    expect(unavailable.seen).toBe(true);
  });
});

describe('matchStartSteps', () => {
  it('runs Timing calibration first when a Match starts with no Timing Offset saved', () => {
    expect(matchStartSteps({ input: 'camera', timingOffsetSaved: false })).toEqual(['calibration']);
  });

  it('starts the Match straight away once a Timing Offset is saved, or with the developer mouse', () => {
    expect(matchStartSteps({ input: 'camera', timingOffsetSaved: true })).toEqual([]);
    expect(matchStartSteps({ input: 'mouse', timingOffsetSaved: false })).toEqual([]);
  });

  it('calibrates the Phone before a Match when it has no Timing Offset of its own', () => {
    expect(matchStartSteps({ input: 'phone', timingOffsetSaved: false })).toEqual(['calibration']);
    expect(matchStartSteps({ input: 'phone', timingOffsetSaved: true })).toEqual([]);
  });
});

describe('cameraErrorMessage', () => {
  const domError = (name: string, message = '') => Object.assign(new Error(message), { name });

  it('tells a player who blocked the camera how to allow it', () => {
    expect(cameraErrorMessage(domError('NotAllowedError'))).toMatch(/blocked.*allow/i);
  });

  it('says when there is no camera, or another app has it', () => {
    expect(cameraErrorMessage(domError('NotFoundError'))).toMatch(/no camera/i);
    expect(cameraErrorMessage(domError('NotReadableError'))).toMatch(/another app/i);
  });

  it('passes on anything else', () => {
    expect(cameraErrorMessage(new Error('Model download failed'))).toMatch(/Model download failed/);
    expect(cameraErrorMessage('weird')).toMatch(/weird/);
  });
});

describe('runOnboarding', () => {
  it('runs each step only after the previous one finishes', async () => {
    const log: string[] = [];
    const finishers = new Map<OnboardingStep, () => void>();
    const step = (name: OnboardingStep) => () => {
      log.push(`start ${name}`);
      return new Promise<void>((resolve) => finishers.set(name, () => (log.push(`end ${name}`), resolve())));
    };
    let done = false;
    const run = runOnboarding(['ask-camera', 'framing', 'calibration'], {
      'ask-camera': step('ask-camera'),
      'start-camera': step('start-camera'),
      framing: step('framing'),
      handedness: step('handedness'),
      calibration: step('calibration'),
      'phone-safety': step('phone-safety'),
      'phone-pairing': step('phone-pairing'),
      'phone-zeroing': step('phone-zeroing'),
      'phone-ready': step('phone-ready'),
    }).then(() => (done = true));

    await Promise.resolve();
    expect(log).toEqual(['start ask-camera']);
    for (const name of ['ask-camera', 'framing', 'calibration'] as const) {
      finishers.get(name)!();
      await new Promise((resolve) => setTimeout(resolve));
    }
    await run;
    expect(log).toEqual([
      'start ask-camera',
      'end ask-camera',
      'start framing',
      'end framing',
      'start calibration',
      'end calibration',
    ]);
    expect(done).toBe(true);
  });
});
