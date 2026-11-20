import type { Hand } from '../sensing/landmarks.ts';
import { createHandPositionStore, type HandPosition, type HandPositionSource } from './handPosition.ts';
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
 * The pointer is also the wrist the Paddle follows, pressed or not (see
 * `mouseHandPosition`).
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
  // A drag needn't rise: the rise rule is about how real arms move (#12).
  const detector = createSwingDetector(() => ({ ...options.params(), minRise: undefined }));
  let hand: Hand | null = null;

  function detect(sample: PointerSample): SwingEvent | null {
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
      detect(sample);
    },
    move(sample) {
      return hand ? detect(sample) : null;
    },
    release() {
      hand = null;
      detector.reset();
    },
  };
}

/** How the pointer stands in for the wrist the Paddle follows. */
export interface MouseReach {
  hand: Hand;
  /** Shoulder widths from the canvas centre to its left or right edge. */
  reachSw: number;
  /** The wrist's `p.y` at the ready, given at the canvas centre. */
  restPy: number;
}

/**
 * The wrist position the pointer stands for, in the units pose gives
 * (shoulder widths: `u` along the body axis, + on the hitting side; `py`
 * downward). For Swing speed the canvas width is one shoulder width; for the
 * Paddle the canvas instead spans the wrist's whole reach, edge to edge, so
 * the developer can sweep the Paddle across the table. The canvas centre is
 * the wrist at the ready; height uses the same scale as width.
 */
export function mouseHandPosition(sample: PointerSample, reach: MouseReach): HandPosition {
  const pxPerSw = sample.width / 2 / reach.reachSw;
  const toHitting = reach.hand === 'left' ? -1 : 1;
  return {
    t: sample.t,
    u: (toHitting * (sample.x - sample.width / 2)) / pxPerSw + 0, // + 0: no −0 at the centre
    py: reach.restPy + (sample.y - sample.height / 2) / pxPerSw,
  };
}

export interface MouseInputOptions extends MouseSwingTrackerOptions {
  /** False while drags mean something else (the debug orbit camera); presses are then ignored. */
  enabled: () => boolean;
  /** Shoulder widths from the canvas centre to its edge, for the Paddle (`PADDLE_MAPPING_RANGE`, so the canvas spans the table). */
  reachSw: () => number;
  /** The wrist's `p.y` at the ready (`PADDLE_REST_PY`), given at the canvas centre. */
  restPy: number;
}

/** Mouse mode's Swings, and the wrist position the Paddle follows. */
export interface MouseInput extends SwingSource, HandPositionSource {}

/** Wire mouse mode to the canvas. Returns the `SwingSource` the game subscribes to, which is also the Paddle's `HandPositionSource`. */
export function installMouseInput(canvas: HTMLCanvasElement, options: MouseInputOptions): MouseInput {
  const tracker = createMouseSwingTracker(options);
  const swings = createSwingEmitter();
  const wrist = createHandPositionStore();
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
    if (event.isPrimary) wrist.set(mouseHandPosition(sample(event), { hand: options.hand(), reachSw: options.reachSw(), restPy: options.restPy }));
    if (event.pointerId !== pointerId) return;
    const swing = tracker.move(sample(event));
    if (swing) swings.emit(swing);
  });
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('lostpointercapture', end);

  return {
    subscribe: swings.subscribe,
    get latest() {
      return wrist.latest;
    },
  };
}
