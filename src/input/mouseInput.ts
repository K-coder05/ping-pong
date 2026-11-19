import type { Hand } from '../sensing/landmarks.ts';
import { createSwingDetector, type SwingParams, type Vec2 } from './swingDetector.ts';
import { createSwingEmitter } from './swingEmitter.ts';
import type { SwingEvent, SwingSource } from './types.ts';

/**
 * Developer mouse mode (SPEC "Swing detection", `?input=mouse`): pointer
 * drags over the canvas become the same `SwingEvent`s the pose detector
 * emits, through the same detector. The pointer stands in for the hitting
 * wrist, the canvas centre for the body midline, and the canvas width (times
 * the `MOUSE_SHOULDER_WIDTH` knob) for the shoulder width, so the Stroke
 * Direction rule is unchanged: a Forehand sweeps toward the non-hitting side,
 * a Backhand toward the hitting side. The screen is read as the mirrored
 * camera view: a right-hander's hitting side is the right half.
 *
 * Developer only: it has no menu entry and is never offered to players.
 */

/** Which input drives Swings: the mouse only with `?input=mouse` in the URL. */
export function swingInputMode(search: string): 'mouse' | 'pose' {
  return new URLSearchParams(search).get('input') === 'mouse' ? 'mouse' : 'pose';
}

/** One pointer sample, in canvas CSS pixels (y down), with the canvas size. */
export interface PointerSample {
  /** Event time, ms, `performance.now()` clock. */
  t: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MouseSwingTrackerOptions {
  params: () => SwingParams;
  /** The player's hitting hand, read at each press. */
  hand: () => Hand;
  /** Shoulder width as a share of the canvas width (1 = the SPEC's screen width). */
  shoulderWidth: () => number;
}

/** Pure core of mouse mode: press / move / release in, Swings out. */
export interface MouseSwingTracker {
  /** A button went down: a new stroke starts here. */
  press(sample: PointerSample): void;
  /** The pointer moved; only counts while pressed. Returns the Swing whose Onset is this sample, if any. */
  move(sample: PointerSample): SwingEvent | null;
  release(): void;
}

export function createMouseSwingTracker(options: MouseSwingTrackerOptions): MouseSwingTracker {
  const detector = createSwingDetector(options.params);
  let hand: Hand | null = null;

  function feed(sample: PointerSample): SwingEvent | null {
    const cx = sample.width / 2;
    const cy = sample.height / 2;
    const halfShoulder = (sample.width * options.shoulderWidth()) / 2;
    // The hitting shoulder is on the hitting hand's side of the (mirrored) screen.
    const toHitting = hand === 'left' ? -1 : 1;
    const hittingShoulder: Vec2 = { x: cx + toHitting * halfShoulder, y: cy };
    const otherShoulder: Vec2 = { x: cx - toHitting * halfShoulder, y: cy };
    return detector.update({ t: sample.t, wrist: { x: sample.x, y: sample.y }, hittingShoulder, otherShoulder });
  }

  return {
    press(sample) {
      // Each drag is a fresh stroke: no motion, Backswing or cooldown carries over.
      hand = options.hand();
      detector.reset();
      feed(sample);
    },
    move(sample) {
      return hand ? feed(sample) : null;
    },
    release() {
      hand = null;
      detector.reset();
    },
  };
}

export interface MouseInputOptions extends MouseSwingTrackerOptions {
  /** False while drags mean something else (the debug orbit camera); presses are then ignored. */
  enabled: () => boolean;
}

/** Wire mouse mode to the canvas. Returns the `SwingSource` the game subscribes to. */
export function installMouseInput(canvas: HTMLCanvasElement, options: MouseInputOptions): SwingSource {
  const tracker = createMouseSwingTracker(options);
  const swings = createSwingEmitter();
  let pointerId: number | null = null;

  const sample = (event: PointerEvent): PointerSample => {
    const rect = canvas.getBoundingClientRect();
    return { t: event.timeStamp, x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width, height: rect.height };
  };
  const end = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    tracker.release();
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (pointerId !== null || !event.isPrimary || event.button !== 0 || !options.enabled()) return;
    pointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    tracker.press(sample(event));
  });
  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    const swing = tracker.move(sample(event));
    if (swing) swings.emit(swing);
  });
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('lostpointercapture', end);

  return { subscribe: swings.subscribe };
}
