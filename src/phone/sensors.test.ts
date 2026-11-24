import { describe, expect, it, vi } from 'vitest';
import { createRateMeter, createSensorSource, type SensorWindow } from './sensors.ts';
import type { MotionPacket } from './types.ts';

/** A stand-in `window`: dispatches synthetic sensor events, with optional iOS-style `requestPermission`. */
function fakeWindow(perm?: { motion?: () => Promise<string>; orientation?: () => Promise<string> }) {
  const target = new EventTarget();
  const win: SensorWindow & EventTarget = Object.assign(target, {
    DeviceMotionEvent: perm?.motion ? { requestPermission: perm.motion } : {},
    DeviceOrientationEvent: perm?.orientation ? { requestPermission: perm.orientation } : {},
  });
  const motion = (fields: object) => win.dispatchEvent(Object.assign(new Event('devicemotion'), fields));
  const orientation = (fields: object) => win.dispatchEvent(Object.assign(new Event('deviceorientation'), fields));
  return { win, motion, orientation };
}

function clock(t0 = 1000) {
  let t = t0;
  return { now: () => t, set: (v: number) => (t = v), advance: (ms: number) => (t += ms) };
}

describe('createSensorSource: packets', () => {
  it('builds one packet per motion event, with rotation, acceleration, the latest orientation and the time', async () => {
    const { win, motion, orientation } = fakeWindow();
    const c = clock(5000);
    const src = createSensorSource(win, c.now);
    const got: MotionPacket[] = [];
    src.onPacket((p) => got.push(p));
    await src.start();

    orientation({ alpha: 10, beta: -20, gamma: 30 });
    orientation({ alpha: 11, beta: -21, gamma: 31 }); // only the latest is kept
    expect(got).toHaveLength(0); // orientation alone sends nothing

    motion({ rotationRate: { alpha: 400, beta: -150, gamma: 2.5 }, accelerationIncludingGravity: { x: -1, y: 9.8, z: 0.3 } });
    expect(got).toEqual([{ seq: 0, tPhone: 5000, rot: [400, -150, 2.5], acc: [-1, 9.8, 0.3], ori: [11, -21, 31] }]);
  });

  it('increments seq per packet and stamps each with now()', async () => {
    const { win, motion } = fakeWindow();
    const c = clock();
    const src = createSensorSource(win, c.now);
    const got: MotionPacket[] = [];
    src.onPacket((p) => got.push(p));
    await src.start();
    for (let i = 0; i < 5; i++) {
      motion({ rotationRate: { alpha: i, beta: 0, gamma: 0 }, accelerationIncludingGravity: { x: 0, y: 0, z: 0 } });
      c.advance(16);
    }
    expect(got.map((p) => p.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(got.map((p) => p.tPhone)).toEqual([1000, 1016, 1032, 1048, 1064]);
  });

  it('treats missing or null sensor fields as 0, and orientation as 0 until the first event', async () => {
    const { win, motion, orientation } = fakeWindow();
    const src = createSensorSource(win, () => 0);
    const got: MotionPacket[] = [];
    src.onPacket((p) => got.push(p));
    await src.start();

    motion({ rotationRate: null, accelerationIncludingGravity: null });
    orientation({ alpha: null, beta: 45, gamma: null });
    motion({ rotationRate: { alpha: null, beta: 5, gamma: null }, accelerationIncludingGravity: { x: 1, y: null, z: null } });
    expect(got[0]).toMatchObject({ rot: [0, 0, 0], acc: [0, 0, 0], ori: [0, 0, 0] });
    expect(got[1]).toMatchObject({ rot: [0, 5, 0], acc: [1, 0, 0], ori: [0, 45, 0] });
  });

  it('gives each packet its own orientation array', async () => {
    const { win, motion, orientation } = fakeWindow();
    const src = createSensorSource(win, () => 0);
    const got: MotionPacket[] = [];
    src.onPacket((p) => got.push(p));
    await src.start();
    orientation({ alpha: 1, beta: 2, gamma: 3 });
    motion({});
    orientation({ alpha: 4, beta: 5, gamma: 6 });
    motion({});
    expect(got.map((p) => p.ori)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it('sends nothing before start() or after stop(), and seq carries on after a restart', async () => {
    const { win, motion } = fakeWindow();
    const src = createSensorSource(win, () => 0);
    const got: MotionPacket[] = [];
    const off = src.onPacket((p) => got.push(p));
    motion({});
    expect(got).toHaveLength(0);

    await src.start();
    await src.start(); // a second tap doesn't double the listeners
    motion({});
    expect(got).toHaveLength(1);

    src.stop();
    motion({});
    expect(got).toHaveLength(1);

    await src.start();
    motion({});
    expect(got.map((p) => p.seq)).toEqual([0, 1]);

    off();
    motion({});
    expect(got).toHaveLength(2);
  });
});

describe('createSensorSource: rateHz', () => {
  it('measures a simulated 60 Hz stream over the last second', async () => {
    const { win, motion } = fakeWindow();
    const c = clock(0);
    const src = createSensorSource(win, c.now);
    await src.start();
    expect(src.rateHz()).toBe(0);
    for (let i = 0; i < 180; i++) {
      c.set((i * 1000) / 60);
      motion({});
    }
    expect(src.rateHz()).toBe(60);
    c.advance(500); // half a second of silence: half the stream has left the window
    expect(src.rateHz()).toBe(30);
    c.advance(600);
    expect(src.rateHz()).toBe(0);
  });
});

describe('createSensorSource: permission', () => {
  it('unsupported (Android): no prompt needed, listens straight away', async () => {
    const { win, motion } = fakeWindow();
    const src = createSensorSource(win, () => 0);
    const got: MotionPacket[] = [];
    src.onPacket((p) => got.push(p));
    expect(await src.start()).toBe('unsupported');
    motion({});
    expect(got).toHaveLength(1);
  });

  it('granted (iOS): asks for motion and orientation, then listens', async () => {
    const motionAsk = vi.fn(() => Promise.resolve('granted'));
    const orientationAsk = vi.fn(() => Promise.resolve('granted'));
    const { win, motion } = fakeWindow({ motion: motionAsk, orientation: orientationAsk });
    const src = createSensorSource(win, () => 0);
    const got: MotionPacket[] = [];
    src.onPacket((p) => got.push(p));
    expect(await src.start()).toBe('granted');
    expect(motionAsk).toHaveBeenCalledTimes(1);
    expect(orientationAsk).toHaveBeenCalledTimes(1);
    motion({});
    expect(got).toHaveLength(1);
  });

  it('asks for both inside the tap, before awaiting either (iOS needs the gesture)', async () => {
    let resolveMotion!: (s: string) => void;
    const motionAsk = vi.fn(() => new Promise<string>((r) => (resolveMotion = r)));
    const orientationAsk = vi.fn(() => Promise.resolve('granted'));
    const { win } = fakeWindow({ motion: motionAsk, orientation: orientationAsk });
    const started = createSensorSource(win, () => 0).start();
    expect(motionAsk).toHaveBeenCalledTimes(1);
    expect(orientationAsk).toHaveBeenCalledTimes(1);
    resolveMotion('granted');
    expect(await started).toBe('granted');
  });

  it('calls requestPermission on its event class, as iOS requires', async () => {
    const DeviceMotionEvent = {
      requestPermission(this: unknown) {
        return Promise.resolve(this === DeviceMotionEvent ? 'granted' : 'denied');
      },
    };
    const win = Object.assign(new EventTarget(), { DeviceMotionEvent, DeviceOrientationEvent: {} });
    expect(await createSensorSource(win, () => 0).start()).toBe('granted');
  });

  it.each([
    ['motion denied', 'denied', 'granted'],
    ['orientation denied', 'granted', 'denied'],
    ["Chrome's prompt dismissed", 'prompt', 'prompt'],
  ])('denied when %s, and does not listen', async (_, m, o) => {
    const { win, motion } = fakeWindow({ motion: () => Promise.resolve(m), orientation: () => Promise.resolve(o) });
    const src = createSensorSource(win, () => 0);
    const got: MotionPacket[] = [];
    src.onPacket((p) => got.push(p));
    expect(await src.start()).toBe('denied');
    motion({});
    expect(got).toHaveLength(0);
  });

  it('denied when requestPermission rejects or throws (not called from a tap)', async () => {
    const rejects = fakeWindow({ motion: () => Promise.reject(new Error('NotAllowedError')) });
    expect(await createSensorSource(rejects.win, () => 0).start()).toBe('denied');
    const throws = fakeWindow({
      motion: () => {
        throw new Error('NotAllowedError');
      },
    });
    expect(await createSensorSource(throws.win, () => 0).start()).toBe('denied');
  });
});

describe('createRateMeter', () => {
  it('counts marks in the window ending now', () => {
    const c = clock(0);
    const m = createRateMeter(c.now, 1000);
    for (let i = 0; i < 100; i++) {
      c.set(i * 10);
      m.mark();
    }
    // Marks at 0..990; at t = 990 all 100 are within (−10, 990].
    expect(m.rateHz()).toBe(100);
    c.set(1500);
    expect(m.rateHz()).toBe(49); // marks at 510..990
  });
});
