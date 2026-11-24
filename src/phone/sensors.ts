/**
 * The Phone's motion sensors (docs/specs/p3.md, P3-b): a thin wrapper over
 * `devicemotion` and `deviceorientation` that turns each motion event into a
 * `MotionPacket` straight away, with no batching and no timers.
 *
 * `start()` must be called from a tap: iOS only lets a page ask for motion
 * access inside a user gesture. Browsers without `requestPermission` need no
 * prompt, and `start()` says 'unsupported'. Any answer but 'granted' counts as
 * denied, including the 'prompt' that Chrome (which also has
 * `requestPermission`) gives when its prompt is dismissed or can't be shown.
 */
import type { MotionPacket } from './types.ts';

export type SensorPermission = 'granted' | 'denied' | 'unsupported';

export interface SensorSource {
  /** Call from a tap handler. Asks for motion access where the browser needs it, then listens unless denied. */
  start(): Promise<SensorPermission>;
  onPacket(cb: (p: MotionPacket) => void): () => void;
  /** Packets per second, measured over the last second. */
  rateHz(): number;
  /** Stop listening; `seq` carries on if started again. */
  stop(): void;
}

/** What `createSensorSource` needs from `window`; a real `Window` fits. */
export type SensorWindow = Pick<Window, 'addEventListener' | 'removeEventListener'> & {
  DeviceMotionEvent?: unknown;
  DeviceOrientationEvent?: unknown;
};

type Nullable<T> = { [K in keyof T]?: number | null };
interface MotionFields {
  rotationRate?: Nullable<{ alpha: number; beta: number; gamma: number }> | null;
  accelerationIncludingGravity?: Nullable<{ x: number; y: number; z: number }> | null;
}
type OrientationFields = Nullable<{ alpha: number; beta: number; gamma: number }>;
type PermissionAsker = { requestPermission?: () => Promise<string> };

export function createSensorSource(win: SensorWindow, now: () => number): SensorSource {
  const cbs = new Set<(p: MotionPacket) => void>();
  const rate = createRateMeter(now);
  let seq = 0;
  let ori: [number, number, number] = [0, 0, 0];
  let listening = false;

  const onOrientation = (e: Event) => {
    const o = e as OrientationFields;
    ori = [o.alpha ?? 0, o.beta ?? 0, o.gamma ?? 0];
  };
  const onMotion = (e: Event) => {
    const m = e as MotionFields;
    const r = m.rotationRate;
    const a = m.accelerationIncludingGravity;
    const t = now();
    const p: MotionPacket = {
      seq: seq++,
      tPhone: t,
      rot: [r?.alpha ?? 0, r?.beta ?? 0, r?.gamma ?? 0],
      acc: [a?.x ?? 0, a?.y ?? 0, a?.z ?? 0],
      ori: [...ori],
    };
    rate.mark(t);
    for (const cb of cbs) cb(p);
  };

  const listen = () => {
    if (listening) return;
    listening = true;
    win.addEventListener('deviceorientation', onOrientation);
    win.addEventListener('devicemotion', onMotion);
  };

  return {
    async start() {
      const motionAsk = (win.DeviceMotionEvent as PermissionAsker | undefined)?.requestPermission;
      if (typeof motionAsk !== 'function') {
        listen();
        return 'unsupported';
      }
      const orientationAsk = (win.DeviceOrientationEvent as PermissionAsker | undefined)?.requestPermission;
      // Ask for both before awaiting either, so both calls happen inside the tap.
      const asks = [ask(win.DeviceMotionEvent as PermissionAsker)];
      if (typeof orientationAsk === 'function') asks.push(ask(win.DeviceOrientationEvent as PermissionAsker));
      const answers = await Promise.all(asks);
      if (!answers.every((a) => a === 'granted')) return 'denied';
      listen();
      return 'granted';
    },
    onPacket(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    rateHz: () => rate.rateHz(),
    stop() {
      if (!listening) return;
      listening = false;
      win.removeEventListener('deviceorientation', onOrientation);
      win.removeEventListener('devicemotion', onMotion);
    },
  };
}

/** `requestPermission` throws when not called from a gesture; count that as denied. */
function ask(ev: PermissionAsker): Promise<string> {
  try {
    return ev.requestPermission!().catch(() => 'denied');
  } catch {
    return Promise.resolve('denied');
  }
}

/** Counts events and reports their rate over the last `windowMs`. Used on both pages. */
export interface RateMeter {
  /** One event at `t` (default `now()`). Times must not go backwards. */
  mark(t?: number): void;
  /** Events per second over the window ending now. */
  rateHz(): number;
}

export function createRateMeter(now: () => number, windowMs = 1000): RateMeter {
  const times: number[] = [];
  const prune = (tNow: number) => {
    while (times.length > 0 && times[0]! <= tNow - windowMs) times.shift();
  };
  return {
    mark(t = now()) {
      times.push(t);
      prune(t);
    },
    rateHz() {
      prune(now());
      return (times.length * 1000) / windowMs;
    },
  };
}
