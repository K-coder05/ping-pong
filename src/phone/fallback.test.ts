import { describe, expect, it } from 'vitest';
import type { Schedule } from './clock.ts';
import { OPEN_TIMEOUT_MS, REOPEN_TIMEOUT_MS, createFallback, createRelayPacer, type RelayReason } from './fallback.ts';

/** A simulated clock and timer queue: `advance(ms)` runs every timer that falls due, in order. */
function simTime() {
  let t = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const schedule: Schedule = (fn, ms) => {
    const id = nextId++;
    timers.set(id, { at: t + ms, fn });
    return () => timers.delete(id);
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const e of timers) if (e[1].at <= end && (!due || e[1].at < due[1].at)) due = e;
      if (!due) break;
      timers.delete(due[0]);
      t = due[1].at;
      due[1].fn();
    }
    t = end;
  };
  return { now: () => t, schedule, advance, pending: () => timers.size };
}

function setup() {
  const time = simTime();
  const relays: RelayReason[] = [];
  const fallback = createFallback({ now: time.now, schedule: time.schedule }, (r) => relays.push(r));
  return { ...time, fallback, relays };
}

describe('relay fallback', () => {
  it('switches to relay when the channels are not open 5 s after signaling starts', () => {
    const { fallback, relays, advance } = setup();
    fallback.started();
    advance(OPEN_TIMEOUT_MS - 1);
    expect(relays).toEqual([]);
    expect(fallback.state()).toBe('opening');
    advance(1);
    expect(relays).toEqual(['never-opened']);
    expect(fallback.state()).toBe('relay');
  });

  it('stays peer to peer when the channels open within 5 s', () => {
    const { fallback, relays, advance, pending } = setup();
    fallback.started();
    advance(4999);
    fallback.opened();
    advance(60_000);
    expect(relays).toEqual([]);
    expect(fallback.state()).toBe('open');
    expect(pending()).toBe(0);
  });

  it('keeps the 5 s rule running when a connection attempt fails before ever opening', () => {
    const { fallback, relays, advance } = setup();
    fallback.started();
    advance(1000);
    fallback.closed();
    advance(OPEN_TIMEOUT_MS - 1000 - 1);
    expect(relays).toEqual([]);
    advance(1);
    expect(relays).toEqual(['never-opened']);
  });

  it('switches to relay when the channels close and do not reopen within 3 s', () => {
    const { fallback, relays, advance } = setup();
    fallback.started();
    advance(200);
    fallback.opened();
    advance(120_000);
    fallback.closed();
    expect(fallback.state()).toBe('reopening');
    advance(REOPEN_TIMEOUT_MS - 1);
    expect(relays).toEqual([]);
    advance(1);
    expect(relays).toEqual(['not-reopened']);
    expect(fallback.state()).toBe('relay');
  });

  it('does not switch when the channels reopen within 3 s', () => {
    const { fallback, relays, advance, pending } = setup();
    fallback.started();
    fallback.opened();
    fallback.closed();
    advance(REOPEN_TIMEOUT_MS - 1);
    fallback.opened();
    advance(60_000);
    expect(relays).toEqual([]);
    expect(fallback.state()).toBe('open');
    expect(pending()).toBe(0);

    // A second drop gets a fresh 3 s.
    fallback.closed();
    advance(REOPEN_TIMEOUT_MS - 1);
    expect(relays).toEqual([]);
    advance(1);
    expect(relays).toEqual(['not-reopened']);
  });

  it('never switches once cancelled, e.g. when the other page leaves', () => {
    const { fallback, relays, advance, pending } = setup();
    fallback.started();
    advance(3000);
    fallback.cancel();
    advance(60_000);
    fallback.opened();
    fallback.closed();
    advance(60_000);
    expect(relays).toEqual([]);
    expect(fallback.state()).toBe('idle');
    expect(pending()).toBe(0);
  });

  it('starts over when another page joins: the 5 s rule from the new start', () => {
    const { fallback, relays, advance } = setup();
    fallback.started();
    advance(OPEN_TIMEOUT_MS);
    expect(relays).toEqual(['never-opened']);
    fallback.cancel();
    advance(10_000);
    fallback.started();
    advance(OPEN_TIMEOUT_MS - 1);
    expect(relays).toHaveLength(1);
    advance(1);
    expect(relays).toEqual(['never-opened', 'never-opened']);
  });

  it('waits out the full time even if the scheduler fires early', () => {
    let t = 0;
    const timers: { fn: () => void; ms: number }[] = [];
    const relays: RelayReason[] = [];
    const fallback = createFallback(
      { now: () => t, schedule: (fn, ms) => (timers.push({ fn, ms }), () => {}) },
      (r) => relays.push(r),
    );
    fallback.started();
    expect(timers[0]!.ms).toBe(OPEN_TIMEOUT_MS);
    t = 4000; // fired 1 s early
    timers.shift()!.fn();
    expect(relays).toEqual([]);
    expect(timers[0]!.ms).toBe(1000);
    t = 5000;
    timers.shift()!.fn();
    expect(relays).toEqual(['never-opened']);
  });
});

describe('relay pacer', () => {
  /** How many of the packets at `times` it allows. */
  const allowed = (times: number[], hz?: number, burst?: number) => {
    const pacer = createRelayPacer(hz, burst);
    return times.filter((t) => pacer.allow(t)).length;
  };
  const stream = (hz: number, seconds: number) => Array.from({ length: hz * seconds }, (_, i) => (i * 1000) / hz);

  it('lets a 60 Hz Phone through untouched', () => {
    expect(allowed(stream(60, 10))).toBe(600);
  });

  it('thins a 200 Hz Phone to about 90 per second', () => {
    const n = allowed(stream(200, 10));
    expect(n).toBeGreaterThanOrEqual(900);
    expect(n).toBeLessThanOrEqual(904);
  });

  it('never allows more than 94 in any second, even all at once', () => {
    const pacer = createRelayPacer();
    const at: number[] = [];
    for (let t = 0; t < 5000; t += 0.5) if (pacer.allow(t)) at.push(t);
    for (let i = 0; i < at.length; i++) {
      const inSecond = at.filter((t) => t >= at[i]! && t < at[i]! + 1000).length;
      expect(inSecond).toBeLessThanOrEqual(94);
    }
  });

  it('spreads a fast stream evenly: no long gaps', () => {
    const pacer = createRelayPacer();
    const at = stream(200, 5).filter((t) => pacer.allow(t));
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(15);
  });
});
