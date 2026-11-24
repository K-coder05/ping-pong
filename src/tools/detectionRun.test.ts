/**
 * The Detection test's scoring path with either Input (docs/specs/p3.md,
 * P3-d): Phone Swings, put on the laptop's clock by ClockSync over a
 * simulated link, are scored by the same `scoreSession` as the Camera's.
 */
import { describe, expect, it } from 'vitest';
import { createPhoneInput } from '../input/phoneInput.ts';
import { syntheticClip } from '../input/phoneSwing.testkit.ts';
import { createSwingEmitter } from '../input/swingEmitter.ts';
import type { SwingEvent } from '../input/types.ts';
import { ClockSync } from '../phone/clock.ts';
import type { ControlMessage, MotionPacket, PhoneLink } from '../phone/types.ts';
import { scoreSession } from './detectionScore.ts';
import { createDetectionRun } from './detectionRun.ts';

/** The Phone's clock minus the laptop's, ms. */
const PHONE_AHEAD_MS = 1234.5;
/** One-way delays of the control channel, ms: asymmetric, so the estimate is 1 ms off. */
const UP_MS = 4;
const DOWN_MS = 6;
/** Packet delay, ms. */
const PACKET_MS = 8;
/** In a synthetic clip with 200 ms of stillness, the Swing Onset is this long after the first packet. */
const ONSET_AFTER_START_MS = 230;

/**
 * A Phone on a simulated link and a simulated laptop clock: the Phone answers
 * pings (as `answerPings` does) after `UP_MS`, and the answer arrives
 * `DOWN_MS` later. `advanceTo` runs everything due, in time order.
 */
function simulatedPhone() {
  let now = 0;
  let tasks: { at: number; fn: () => void }[] = [];
  const schedule = (fn: () => void, ms: number) => {
    const task = { at: now + ms, fn };
    tasks.push(task);
    return () => void (tasks = tasks.filter((t) => t !== task));
  };
  const advanceTo = (t: number) => {
    for (;;) {
      const due = tasks.filter((task) => task.at <= t).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      tasks = tasks.filter((task) => task !== due);
      now = due.at;
      due.fn();
    }
    now = Math.max(now, t);
  };

  const packetCbs = new Set<(p: MotionPacket, tRecv: number) => void>();
  const controlCbs = new Set<(m: ControlMessage, tRecv: number) => void>();
  const control = (m: ControlMessage) => controlCbs.forEach((cb) => cb(m, now));
  const link: PhoneLink = {
    status: () => 'connected',
    onStatus: () => () => {},
    onPacket: (cb) => (packetCbs.add(cb), () => packetCbs.delete(cb)),
    onControl: (cb) => (controlCbs.add(cb), () => controlCbs.delete(cb)),
    sendPacket: () => {},
    sendControl: (m) => {
      if (m.type !== 'ping') return;
      const t1 = now + UP_MS + PHONE_AHEAD_MS;
      schedule(() => control({ type: 'pong', t0: m.t0, t1, t2: t1 + 0.5 }), UP_MS + 0.5 + DOWN_MS);
    },
    close: () => {},
  };

  let seq = 0;
  /** One synthetic clip (a Zeroing, stillness, then a Forehand unless `stroke` is false) whose Swing Onset is at laptop time `onsetAt`. */
  const clip = (onsetAt: number, stroke = true) => {
    const entries = syntheticClip({ hand: 'right', side: stroke ? 'forehand' : undefined, clockOffsetMs: PHONE_AHEAD_MS, delayMs: PACKET_MS, stillMs: 200 });
    const firstPacket = entries.find((e) => e.type === 'packet')!;
    const shift = onsetAt - ONSET_AFTER_START_MS - (firstPacket.tPhone - PHONE_AHEAD_MS);
    for (const e of entries) {
      advanceTo(e.tRecv + shift);
      if (e.type === 'zero') control({ type: 'zero' });
      else {
        const { type: _type, tRecv: _tRecv, ...packet } = e;
        packetCbs.forEach((cb) => cb({ ...packet, seq: seq++, tPhone: packet.tPhone + shift }, now));
      }
    }
  };

  return { link, schedule, advanceTo, clip, now: () => now };
}

describe('createDetectionRun', () => {
  const idle = (lastTick: number) => ({ start: lastTick + 1500, end: lastTick + 61_500 });

  it('collects Onsets only during the ticks and the idle phase, and scores them with scoreSession', () => {
    const swings = createSwingEmitter();
    const run = createDetectionRun(swings);
    const at = (t: number) => swings.emit({ t, peakSpeed: 5, side: 'forehand', vertPath: 0 });
    at(500); // before Start: ignored
    run.begin([1000, 3000, 5000], 100);
    expect(run.phase).toBe('ticks');
    at(1100);
    at(3050);
    expect(run.startIdle()).toEqual(idle(5000));
    at(20_000);
    const score = run.finish();
    at(30_000); // after the end: ignored
    expect(run.onsets).toEqual([1100, 3050, 20_000]);
    expect(score).toEqual(scoreSession({ tickTimes: [1000, 3000, 5000], onsets: [1100, 3050, 20_000], idle: idle(5000), timingOffsetMs: 100 }));
    expect(score).toMatchObject({ detected: 2, total: 3, falseTriggers: 1 });
  });

  it('forgets the last run on Start again', () => {
    const swings = createSwingEmitter();
    const run = createDetectionRun(swings);
    run.begin([1000], 0);
    swings.emit({ t: 1000, peakSpeed: 5, side: 'forehand', vertPath: 0 });
    run.finish();
    run.reset();
    run.begin([9000], 0);
    expect(run.onsets).toEqual([]);
  });

  it('scores Phone Swings, on the laptop clock through ClockSync, with the same scoring', () => {
    const phone = simulatedPhone();
    const sync = new ClockSync(phone.link, phone.now, { schedule: phone.schedule });
    sync.start();
    phone.advanceTo(3000);
    expect(sync.isSynced()).toBe(true);

    const input = createPhoneInput(phone.link, phone.now, sync, () => 'right');
    const seen: SwingEvent[] = [];
    input.subscribe((s) => seen.push(s));
    const run = createDetectionRun(input);

    phone.clip(5000); // a practice Swing before Start: not scored
    const ticks = [10_000, 11_800, 13_600, 15_400, 17_200];
    run.begin(ticks, 0);
    // A Swing 80 ms after each tick except the third.
    for (const tick of ticks.filter((_, i) => i !== 2)) phone.clip(tick + 80);
    const idlePhase = run.startIdle();
    phone.clip(idlePhase.start + 10_000, false); // standing still: nothing
    phone.clip(idlePhase.start + 20_000); // a false trigger
    phone.advanceTo(idlePhase.end + 400);
    const score = run.finish();

    expect(score).toMatchObject({ detected: 4, total: 5, falseTriggers: 1 });
    // Each Onset on the laptop's clock, within the clock sync's error, not the Phone's 1,234.5 ms ahead.
    const expected = [...ticks.filter((_, i) => i !== 2).map((t) => t + 80), idlePhase.start + 20_000];
    expect(run.onsets).toHaveLength(expected.length);
    run.onsets.forEach((t, i) => expect(Math.abs(t - expected[i]!)).toBeLessThan(3));
    expect(seen).toHaveLength(6); // the practice Swing too
  });

  it("puts a Phone Swing on the laptop's clock with the provisional estimate, before the first full round", () => {
    const phone = simulatedPhone();
    const sync = new ClockSync(phone.link, phone.now, { schedule: phone.schedule });
    sync.start();
    phone.advanceTo(20); // one answer in, the round still going
    expect(sync.isSynced()).toBe(false);
    const input = createPhoneInput(phone.link, phone.now, sync, () => 'right');
    const run = createDetectionRun(input);
    run.begin([300], 0);
    phone.clip(380);
    expect(run.onsets).toHaveLength(1);
    expect(Math.abs(run.onsets[0]! - 380)).toBeLessThan(3);
  });
});
