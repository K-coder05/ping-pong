import { describe, expect, it } from 'vitest';
import { parsePlayLog, serializePlayLog, type PlayLogEntry } from '../game/playLog.ts';
import { makeRng } from '../util/rng.ts';
import { fitPlayer } from './fitPlayer.ts';

/** A standard normal draw from a uniform source (Box-Muller). */
function gauss(random: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

function syntheticLog(n: number, seed: number): PlayLogEntry[] {
  const random = makeRng(seed);
  const entries: PlayLogEntry[] = [];
  for (let i = 0; i < n; i++) {
    if (random() < 0.1) {
      entries.push({ mode: 'drill', idealAtMs: i * 2000, outcome: 'miss' });
      continue;
    }
    entries.push({
      mode: 'drill',
      idealAtMs: i * 2000,
      outcome: 'accepted',
      delta: 35 + 55 * gauss(random),
      peakSpeed: 6 + 1.5 * gauss(random),
      vertPath: 0.3 + 0.8 * gauss(random),
    });
  }
  return entries;
}

describe('fitPlayer', () => {
  it('recovers the timing mean and spread within 5 ms, through a log file round trip', () => {
    const entries = parsePlayLog(serializePlayLog(syntheticLog(3000, 11)));
    const model = fitPlayer(entries, { name: 'synthetic', detectRate: 0.9 });
    expect(Math.abs(model.timingMeanMs - 35)).toBeLessThan(5);
    expect(Math.abs(model.timingSdMs - 55)).toBeLessThan(5);
    expect(model.speedMean).toBeCloseTo(6, 0);
    expect(model.speedSd).toBeCloseTo(1.5, 0);
    expect(model.vertPathMean).toBeCloseTo(0.3, 0);
    expect(model.vertPathSd).toBeCloseTo(0.8, 0);
    expect(model.name).toBe('synthetic');
    expect(model.detectRate).toBe(0.9);
  });

  it('counts Early and Late Swings toward timing, but not Misses', () => {
    const model = fitPlayer(
      [
        { mode: 'drill', idealAtMs: 0, outcome: 'early', delta: -300 },
        { mode: 'drill', idealAtMs: 1, outcome: 'late', delta: 300 },
        { mode: 'drill', idealAtMs: 2, outcome: 'miss' },
        { mode: 'drill', idealAtMs: 3, outcome: 'accepted', delta: 0, peakSpeed: 5, vertPath: 0 },
        { mode: 'drill', idealAtMs: 4, outcome: 'accepted', delta: 0, peakSpeed: 7, vertPath: 1 },
      ],
      { name: 'x', detectRate: 1 },
    );
    expect(model.timingMeanMs).toBe(0);
    expect(model.speedMean).toBe(6);
  });

  it('throws when there is too little to fit, or the detect rate is not a rate', () => {
    expect(() => fitPlayer([], { name: 'x', detectRate: 0.9 })).toThrow(/Swing/);
    expect(() => fitPlayer(syntheticLog(50, 1), { name: 'x', detectRate: 1.5 })).toThrow(/detect/i);
  });
});
