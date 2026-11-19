import { describe, expect, it } from 'vitest';
import { scoreSession } from './detectionScore.ts';

const idle = { start: 10_000, end: 70_000 };

describe('scoreSession', () => {
  it('counts a tick detected when exactly one Onset is within 300 ms', () => {
    const r = scoreSession({ tickTimes: [1000, 2000], onsets: [1100, 1850], idle });
    expect(r.detected).toBe(2);
    expect(r.total).toBe(2);
  });

  it('includes the 300 ms boundary and excludes beyond it', () => {
    expect(scoreSession({ tickTimes: [1000], onsets: [1300], idle }).detected).toBe(1);
    expect(scoreSession({ tickTimes: [1000], onsets: [700], idle }).detected).toBe(1);
    expect(scoreSession({ tickTimes: [1000], onsets: [1301], idle }).detected).toBe(0);
  });

  it('does not count a tick with two Onsets in the window', () => {
    expect(scoreSession({ tickTimes: [1000], onsets: [900, 1200], idle }).detected).toBe(0);
  });

  it('does not count a tick with no Onset', () => {
    expect(scoreSession({ tickTimes: [1000], onsets: [], idle }).detected).toBe(0);
  });

  it('counts only idle-phase Onsets as false triggers, per minute', () => {
    const r = scoreSession({ tickTimes: [1000], onsets: [1000, 5000, 20_000, 30_000, 69_999, 70_000], idle });
    expect(r.falseTriggers).toBe(3);
    expect(r.falseTriggersPerMinute).toBe(3);
  });

  it('scales false triggers by the idle duration', () => {
    const r = scoreSession({ tickTimes: [], onsets: [11_000], idle: { start: 10_000, end: 40_000 } });
    expect(r.falseTriggersPerMinute).toBe(2);
  });
});
