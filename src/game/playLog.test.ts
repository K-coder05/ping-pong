import { describe, expect, it } from 'vitest';
import type { SwingEvent } from '../input/types.ts';
import { makeRng } from '../util/rng.ts';
import { createGameCore } from './core.ts';
import { createPlayLogRecorder, parsePlayLog, serializePlayLog, type PlayLogEntry } from './playLog.ts';
import { knobResolverParams } from './shotResolver.ts';

describe('play log text', () => {
  it('round-trips entries, one JSON line each', () => {
    const entries: PlayLogEntry[] = [
      { mode: 'drill', idealAtMs: 1234.5678, outcome: 'accepted', delta: -12.25, peakSpeed: 6.1234567, vertPath: -0.4 },
      { mode: 'drill', idealAtMs: 5000, outcome: 'miss' },
      { mode: 'match', idealAtMs: 9000.1, outcome: 'late', delta: 260 },
    ];
    const text = serializePlayLog(entries);
    expect(text.trimEnd().split('\n')).toHaveLength(3);
    expect(parsePlayLog(text)).toEqual(entries);
  });

  it('parses an empty log and skips blank lines', () => {
    expect(parsePlayLog('')).toEqual([]);
    expect(parsePlayLog('\n{"mode":"drill","idealAtMs":1,"outcome":"miss"}\n\n')).toHaveLength(1);
  });

  it('rejects a line that is not an entry, naming the line', () => {
    expect(() => parsePlayLog('{"mode":"drill","idealAtMs":1,"outcome":"miss"}\n{"mode":"x"}')).toThrow(/line 2/);
    expect(() => parsePlayLog('not json')).toThrow(/line 1/);
  });
});

describe('a headless drill', () => {
  it('writes entries that parse back identically, one per Feed that reaches the player', () => {
    const random = makeRng(7);
    const scriptRandom = makeRng(99);
    const core = createGameCore({ random, resolverParams: knobResolverParams, hand: () => 'right' });
    const recorder = createPlayLogRecorder({ mode: 'drill' });
    core.feeder.onFeed((feed) => recorder.startFeed(feed.idealAtMs));
    core.onShot((event) => recorder.shot(event));

    // A scripted player: for each Feed, swing at the Ideal Time plus a drawn
    // error (some Early, some Late), or not at all.
    let scheduled = null as { feedAtMs: number; atMs: number | null } | null;
    const frameMs = 1000 / 60;
    let feeds = 0;
    for (let nowMs = 1000; nowMs < 1000 + 200_000; nowMs += frameMs) {
      const feed = core.feeder.currentFeed;
      if (feed && feed.idealAtMs !== null && scheduled?.feedAtMs !== feed.launchedAtMs) {
        feeds++;
        const roll = scriptRandom();
        const error = roll < 0.15 ? -350 : roll < 0.3 ? 350 : (scriptRandom() - 0.5) * 200;
        scheduled = { feedAtMs: feed.launchedAtMs, atMs: roll > 0.9 ? null : feed.idealAtMs + error };
      }
      if (scheduled && scheduled.atMs !== null && nowMs >= scheduled.atMs) {
        const swing: SwingEvent = { t: nowMs, peakSpeed: 4 + scriptRandom() * 4, side: 'forehand', vertPath: scriptRandom() - 0.5 };
        scheduled.atMs = null;
        core.swing(swing, nowMs);
      }
      core.frame({ nowMs, elapsedSeconds: frameMs / 1000 });
    }

    const entries = recorder.entries;
    expect(feeds).toBeGreaterThan(20);
    expect(entries.length).toBe(feeds);
    const outcomes = new Set(entries.map((e) => e.outcome));
    for (const outcome of ['accepted', 'early', 'late', 'miss'] as const) expect(outcomes).toContain(outcome);
    for (const e of entries) {
      expect(e.mode).toBe('drill');
      if (e.outcome === 'accepted') {
        expect(e.peakSpeed).toBeGreaterThan(0);
        expect(e.vertPath).toBeDefined();
      }
      if (e.outcome === 'miss') expect(e.delta).toBeUndefined();
      else expect(e.delta).toBeDefined();
    }
    expect(parsePlayLog(recorder.toText())).toEqual(entries);
  });
});
