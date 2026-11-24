import { describe, expect, it } from 'vitest';
import { makeRng } from '../util/rng.ts';
import { ClockSync, answerPings, clockSample, estimateOffset, linkStats, type ClockOffset, type Schedule } from './clock.ts';
import type { ControlMessage, LinkStatus, MotionPacket, PhoneLink } from './types.ts';

/** Simulated laptop time with a timer queue, so fractional delays run in order. */
function simTime() {
  let t = 0;
  let nextId = 0;
  const queue: { at: number; id: number; fn: () => void }[] = [];
  const schedule: Schedule = (fn, ms) => {
    const item = { at: t + ms, id: nextId++, fn };
    queue.push(item);
    return () => {
      const i = queue.indexOf(item);
      if (i >= 0) queue.splice(i, 1);
    };
  };
  /** Run every timer due up to `until`, in time order. */
  const runUntil = (until: number) => {
    for (;;) {
      queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = queue[0];
      if (!next || next.at > until) break;
      queue.shift();
      t = next.at;
      next.fn();
    }
    t = until;
  };
  return { now: () => t, schedule, runUntil };
}

type ControlCb = (m: ControlMessage, tRecv: number) => void;
interface SimEnd {
  now: () => number;
  cbs: Set<ControlCb>;
  sent: ControlMessage[];
  link: PhoneLink;
}

/** One end of a simulated control channel: what it sends reaches `peer()` after `delay()` ms, stamped with the peer's clock. */
function simEnd(sim: ReturnType<typeof simTime>, now: () => number, delay: () => number, peer: () => SimEnd): SimEnd {
  const cbs = new Set<ControlCb>();
  const sent: ControlMessage[] = [];
  const link: PhoneLink = {
    status: (): LinkStatus => 'connected',
    onStatus: () => () => {},
    onPacket: () => () => {},
    onControl: (cb) => {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    sendPacket: () => {},
    sendControl: (m) => {
      sent.push(m);
      sim.schedule(() => {
        const to = peer();
        const tRecv = to.now();
        for (const cb of [...to.cbs]) cb(m, tRecv);
      }, delay());
    },
    close: () => {},
  };
  return { now, cbs, sent, link };
}

/** A laptop and a simulated Phone with its own clock, answering pings with `answerPings` like `phone.html`; random delays each way. */
function setup(opts: { seed: number; maxDelayMs: number; phoneClock: (tLaptop: number) => number }) {
  const sim = simTime();
  const rng = makeRng(opts.seed);
  const phoneNow = () => opts.phoneClock(sim.now());
  const laptop: SimEnd = simEnd(sim, sim.now, () => rng() * opts.maxDelayMs, () => phone);
  const phone: SimEnd = simEnd(sim, phoneNow, () => rng() * opts.maxDelayMs, () => laptop);
  answerPings(phone.link, phoneNow);
  // The spec's defaults, written out: 20 answers per round, a re-sync every 10 s.
  const sync = new ClockSync(laptop.link, sim.now, { samples: 20, resyncMs: 10_000, schedule: sim.schedule });
  return { sim, sync, laptopSent: laptop.sent };
}

describe('clockSample', () => {
  it('splits the round trip evenly: offset and round trip from the four times', () => {
    // Phone is 1000 ms ahead; 10 ms out, 2 ms on the Phone, 30 ms back.
    const s = clockSample(0, 1010, 1012, 42);
    expect(s.delta).toBe(40);
    expect(s.theta).toBe(990); // off by (10 − 30) / 2: the asymmetry, at most δ / 2
  });
});

describe('estimateOffset', () => {
  it('takes the median offset of the quarter with the smallest round trip', () => {
    const samples = [
      ...[1, 2, 3, 4, 5].map((d, i) => ({ theta: 100 + i, delta: d })), // the kept quarter, median 102
      ...Array.from({ length: 15 }, (_, i) => ({ theta: 500 + i, delta: 50 + i })),
    ];
    expect(estimateOffset(samples)).toEqual({ offsetMs: 102, rttMs: 3 });
  });
});

describe('answerPings', () => {
  it('answers a ping with pong { t0, t1: receive time, t2: send time } and ignores everything else', () => {
    const sent: ControlMessage[] = [];
    let cb: ((m: ControlMessage, tRecv: number) => void) | null = null;
    const link = {
      onControl: (f: typeof cb) => {
        cb = f;
        return () => {};
      },
      sendControl: (m: ControlMessage) => sent.push(m),
    } as unknown as PhoneLink;
    answerPings(link, () => 507);
    cb!({ type: 'zero' }, 500);
    cb!({ type: 'ping', t0: 12.25 }, 505);
    expect(sent).toEqual([{ type: 'pong', t0: 12.25, t1: 505, t2: 507 }]);
  });
});

/** ms by which the five back-to-back warm-up rounds have finished, even at the slowest (20 × (25 + 60) ms each, 500 ms apart). */
const WARM_MS = 10_500;
const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

describe('ClockSync', () => {
  it('estimates a 1,234.5 ms offset within 5 ms over random, asymmetric 0–30 ms delays each way', () => {
    for (const seed of SEEDS) {
      const { sim, sync } = setup({ seed, maxDelayMs: 30, phoneClock: (t) => t + 1234.5 });
      sync.start();
      sim.runUntil(WARM_MS);
      expect(sync.isSynced()).toBe(true);
      expect(Math.abs(sync.offsetMs() - 1234.5)).toBeLessThan(5);
      expect(Math.abs(sync.toLocal(sim.now() + 1234.5) - sim.now())).toBeLessThan(5);
      expect(sync.rttMs()).toBeGreaterThanOrEqual(0);
      expect(sync.rttMs()).toBeLessThan(30);
    }
  });

  /** |estimate − truth| every 500 ms from the end of the warm-up to 5 minutes, on a Phone clock drifting 50 ppm. */
  function driftErrors(seed: number) {
    const trueOffset = (t: number) => 1234.5 + t * 50e-6;
    const { sim, sync } = setup({ seed, maxDelayMs: 30, phoneClock: (t) => t + trueOffset(t) });
    sync.start();
    const errors: number[] = [];
    for (let t = WARM_MS; t <= 300_000; t += 500) {
      sim.runUntil(t);
      errors.push(Math.abs(sync.offsetMs() - trueOffset(t)));
      // toLocal carries the offset forward with the learned drift too.
      errors.push(Math.abs(sync.toLocal(t + trueOffset(t)) - t));
    }
    return errors;
  }

  it('tracks a 50 ppm drift over 5 minutes within 5 ms', () => {
    // 15 ms of drift over the run: three times the tolerance.
    expect(Math.max(...driftErrors(1))).toBeLessThan(5);
  });

  it('tracks the drift across many random links: typically within 1.5 ms, rarely past 5 ms', () => {
    const all = SEEDS.flatMap(driftErrors).sort((a, b) => a - b);
    const at = (q: number) => all[Math.floor(q * (all.length - 1))]!;
    // Over 200 seeds: about 0.9 ms median, 4.6 ms at the 99.9th percentile; a round's error can reach 10 ms on
    // this harsh uniform jitter, so a handful of moments in 200 runs pass 5 ms by a fraction of a millisecond.
    expect(at(0.5)).toBeLessThan(1.5);
    expect(at(0.999)).toBeLessThan(5);
  });

  it('pings one at a time, 20 per round: five rounds back to back, then one every 10 s', () => {
    const { sim, sync, laptopSent } = setup({ seed: 3, maxDelayMs: 30, phoneClock: (t) => t + 50 });
    sync.start();
    expect(laptopSent).toHaveLength(1); // the next ping waits for this one's answer
    sim.runUntil(1000);
    expect(laptopSent.length).toBeLessThanOrEqual(20);
    sim.runUntil(WARM_MS);
    expect(laptopSent).toHaveLength(100);
    sim.runUntil(14_000);
    expect(laptopSent).toHaveLength(100);
    sim.runUntil(WARM_MS + 12_000);
    expect(laptopSent).toHaveLength(120);
    expect(laptopSent.every((m) => m.type === 'ping')).toBe(true);
  });

  it('has a provisional offset from the first answer, before the round finishes', () => {
    const { sim, sync } = setup({ seed: 4, maxDelayMs: 30, phoneClock: (t) => t + 1234.5 });
    expect(sync.offsetMs()).toBe(0);
    expect(sync.rttMs()).toBeNaN();
    sync.start();
    sim.runUntil(61); // one round trip at most 60 ms
    expect(sync.isSynced()).toBe(false);
    expect(Math.abs(sync.offsetMs() - 1234.5)).toBeLessThanOrEqual(15); // within half its round trip
  });

  it('pings again when an answer never comes (the link was down)', () => {
    const sim = simTime();
    const sent: ControlMessage[] = [];
    const link = {
      onControl: () => () => {},
      sendControl: (m: ControlMessage) => sent.push(m),
    } as unknown as PhoneLink;
    const sync = new ClockSync(link, sim.now, { schedule: sim.schedule });
    sync.start();
    sim.runUntil(3500);
    expect(sent.map((m) => m.type === 'ping' && m.t0)).toEqual([0, 1000, 2000, 3000]);
  });

  it('ignores pongs that do not answer the ping in flight', () => {
    const sim = simTime();
    let cb: ((m: ControlMessage, tRecv: number) => void) | null = null;
    const link = {
      onControl: (f: typeof cb) => {
        cb = f;
        return () => {};
      },
      sendControl: () => {},
    } as unknown as PhoneLink;
    const sync = new ClockSync(link, sim.now, { schedule: sim.schedule });
    sync.start();
    cb!({ type: 'pong', t0: -1, t1: 9999, t2: 9999 }, 0);
    expect(sync.rttMs()).toBeNaN();
    cb!({ type: 'pong', t0: 0, t1: 100, t2: 100 }, 0);
    expect(sync.offsetMs()).toBe(100);
    cb!({ type: 'pong', t0: 0, t1: 900, t2: 900 }, 0); // the same ping answered twice
    expect(sync.offsetMs()).toBe(100);
  });

  it('takes a jump at once when the Phone clock restarts, instead of blending it in', () => {
    let base = 1234.5;
    const { sim, sync } = setup({ seed: 5, maxDelayMs: 30, phoneClock: (t) => t + base });
    sync.start();
    sim.runUntil(5000);
    base = -40_000; // the Phone page reloaded: its performance.now() starts again
    sim.runUntil(20_000);
    expect(Math.abs(sync.offsetMs() - base)).toBeLessThan(5);
  });

  it('stops pinging on stop(), keeps its estimate, and carries on from it on start()', () => {
    const { sim, sync, laptopSent } = setup({ seed: 6, maxDelayMs: 30, phoneClock: (t) => t + 1234.5 });
    sync.start();
    sim.runUntil(WARM_MS);
    sync.stop();
    const offset = sync.offsetMs();
    sim.runUntil(60_000);
    expect(laptopSent).toHaveLength(100);
    expect(sync.offsetMs()).toBe(offset); // no drift learned yet, so it holds still
    sync.start(); // one round now, no second warm-up
    expect(sync.isSynced()).toBe(true);
    sim.runUntil(65_000);
    expect(laptopSent).toHaveLength(120);
  });

  it('can stand in for the Phone Input clock offset', () => {
    const { sync } = setup({ seed: 1, maxDelayMs: 0, phoneClock: (t) => t });
    const offset: ClockOffset = sync;
    expect(offset.toLocal(10)).toBe(10);
  });
});

describe('linkStats', () => {
  const offset = (theta: number): ClockOffset => ({ toLocal: (t) => t - theta });
  /** A 100 Hz stream on a Phone clock 1000 ms ahead, each packet `delay(i)` ms on the way. */
  const stream = (seqs: number[], delay: (i: number) => number) =>
    seqs.map((seq, i) => ({ seq, tPhone: 1000 + seq * 10, tRecv: seq * 10 + delay(i) }));

  it('reports loss from seq gaps', () => {
    const all = Array.from({ length: 200 }, (_, i) => i + 50);
    const missing = new Set([52, 60, 61, 62, 100, 177, 178, 199, 230, 248]);
    const got = stream(
      all.filter((s) => !missing.has(s)),
      () => 5,
    );
    expect(linkStats(got, offset(1000)).lossPct).toBeCloseTo(5); // 10 of 200
  });

  it('counts loss correctly when packets arrive out of order or twice', () => {
    const got = stream([3, 1, 0, 5, 5, 4], () => 5); // 2 missing of 0–5
    expect(linkStats(got, offset(1000)).lossPct).toBeCloseTo((100 * 1) / 6);
  });

  it('reports no loss for a complete stream', () => {
    expect(linkStats(stream([0, 1, 2, 3], () => 5), offset(1000)).lossPct).toBe(0);
  });

  it('reports the one-way delay p50 and p95 on the laptop clock', () => {
    // Delays 1..100 ms in a shuffled order.
    const rng = makeRng(11);
    const delays = Array.from({ length: 100 }, (_, i) => i + 1).sort(() => rng() - 0.5);
    const s = linkStats(
      stream(
        Array.from({ length: 100 }, (_, i) => i),
        (i) => delays[i]!,
      ),
      offset(1000),
    );
    expect(s.oneWayP50).toBeCloseTo(50);
    expect(s.oneWayP95).toBeCloseTo(95);
  });

  it("reports the Phone's sample rate, not lowered by loss", () => {
    const seqs = Array.from({ length: 120 }, (_, i) => i).filter((s) => s % 10 !== 3);
    expect(linkStats(stream(seqs, () => 5), offset(1000)).rateHz).toBeCloseTo(100);
  });

  it('is empty-safe', () => {
    const s = linkStats([], offset(0));
    expect(s.lossPct).toBe(0);
    expect(s.rateHz).toBe(0);
    expect(s.oneWayP50).toBeNaN();
  });

  it('uses the ClockSync offset for the delay', () => {
    const { sim, sync } = setup({ seed: 2, maxDelayMs: 30, phoneClock: (t) => t + 1234.5 });
    sync.start();
    sim.runUntil(5000);
    const packets: Pick<MotionPacket, 'seq' | 'tPhone'>[] = [{ seq: 0, tPhone: 7000 + 1234.5 }];
    const s = linkStats(
      packets.map((p) => ({ ...p, tRecv: 7012 })),
      sync,
    );
    expect(Math.abs(s.oneWayP50 - 12)).toBeLessThan(5);
  });
});
