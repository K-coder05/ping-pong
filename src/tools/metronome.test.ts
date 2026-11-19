import { describe, expect, it } from 'vitest';
import { createMetronome, type MetronomeOptions } from './metronome.ts';

/** Fake clock plus a polling timer the test drives by advancing time. */
function harness(options: Partial<MetronomeOptions> = {}) {
  let time = 1000;
  let poll: (() => void) | null = null;
  const log: string[] = [];
  const metronome = createMetronome({
    count: 3,
    intervalMs: 500,
    leadInMs: 200,
    lookaheadMs: 50,
    now: () => time,
    timer: {
      start: (fn) => {
        poll = fn;
      },
      stop: () => {
        poll = null;
      },
    },
    onSchedule: (i, t) => log.push(`schedule ${i}@${t} (now ${time})`),
    onTick: (i, t) => log.push(`tick ${i}@${t} (now ${time})`),
    onEnd: () => log.push(`end (now ${time})`),
    ...options,
  });
  const advanceTo = (t: number, step = 10) => {
    while (time < t) {
      time = Math.min(t, time + step);
      poll?.();
    }
  };
  return { metronome, log, advanceTo, running: () => poll !== null };
}

describe('metronome', () => {
  it('fixes tick times at a steady interval after the lead-in', () => {
    const { metronome } = harness();
    metronome.start();
    expect(metronome.tickTimes).toEqual([1200, 1700, 2200]);
  });

  it('has no tick times before start', () => {
    expect(harness().metronome.tickTimes).toEqual([]);
  });

  it('announces each tick ahead of time, then at its time, then ends', () => {
    const { metronome, log, advanceTo } = harness();
    metronome.start();
    advanceTo(3000);
    expect(log).toEqual([
      'schedule 0@1200 (now 1150)',
      'tick 0@1200 (now 1200)',
      'schedule 1@1700 (now 1650)',
      'tick 1@1700 (now 1700)',
      'schedule 2@2200 (now 2150)',
      'tick 2@2200 (now 2200)',
      'end (now 2200)',
    ]);
  });

  it('stops polling after the last tick', () => {
    const { metronome, advanceTo, running } = harness();
    metronome.start();
    advanceTo(3000);
    expect(running()).toBe(false);
    expect(metronome.running).toBe(false);
  });

  it('stop cancels the remaining ticks without ending', () => {
    const { metronome, log, advanceTo, running } = harness();
    metronome.start();
    advanceTo(1300);
    metronome.stop();
    advanceTo(3000);
    expect(running()).toBe(false);
    expect(log.filter((l) => l.startsWith('tick'))).toEqual(['tick 0@1200 (now 1200)']);
    expect(log.some((l) => l.startsWith('end'))).toBe(false);
  });

  it('can run again with fresh tick times', () => {
    const { metronome, advanceTo } = harness();
    metronome.start();
    advanceTo(3000);
    metronome.start();
    expect(metronome.tickTimes).toEqual([3200, 3700, 4200]);
  });

  it('fires every tick exactly once, in order, even if the timer is late', () => {
    const { metronome, log, advanceTo } = harness();
    metronome.start();
    advanceTo(3000, 5000);
    const ticks = log.filter((l) => l.startsWith('tick')).map((l) => l.split(' ')[1]);
    expect(ticks).toEqual(['0@1200', '1@1700', '2@2200']);
    expect(log.filter((l) => l.startsWith('end'))).toHaveLength(1);
  });
});
