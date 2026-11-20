import { describe, expect, it } from 'vitest';
import { cameraErrorMessage, matchStartSteps, onboardingSteps, runOnboarding, type OnboardingStep } from './onboarding.ts';

describe('onboardingSteps', () => {
  it('takes a first-time player through camera, framing, handedness and Timing calibration, in order', () => {
    expect(onboardingSteps({ input: 'pose', handSaved: false, timingOffsetSaved: false })).toEqual([
      'ask-camera',
      'framing',
      'handedness',
      'calibration',
    ]);
  });

  it('sends a returning player straight to the drill once the camera starts', () => {
    expect(onboardingSteps({ input: 'pose', handSaved: true, timingOffsetSaved: true })).toEqual(['start-camera']);
  });

  it('only asks for what is missing, with the framing instruction before it', () => {
    expect(onboardingSteps({ input: 'pose', handSaved: true, timingOffsetSaved: false })).toEqual([
      'ask-camera',
      'framing',
      'calibration',
    ]);
    expect(onboardingSteps({ input: 'pose', handSaved: false, timingOffsetSaved: true })).toEqual([
      'ask-camera',
      'framing',
      'handedness',
    ]);
  });

  it('skips onboarding with the developer mouse', () => {
    expect(onboardingSteps({ input: 'mouse', handSaved: false, timingOffsetSaved: false })).toEqual([]);
  });
});

describe('matchStartSteps', () => {
  it('runs Timing calibration first when a Match starts with no Timing Offset saved', () => {
    expect(matchStartSteps({ input: 'pose', timingOffsetSaved: false })).toEqual(['calibration']);
  });

  it('starts the Match straight away once a Timing Offset is saved, or with the developer mouse', () => {
    expect(matchStartSteps({ input: 'pose', timingOffsetSaved: true })).toEqual([]);
    expect(matchStartSteps({ input: 'mouse', timingOffsetSaved: false })).toEqual([]);
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
