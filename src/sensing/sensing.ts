import { ONE_EURO_BETA, ONE_EURO_MIN_CUTOFF } from '../game/constants.ts';
import { openCamera } from './camera.ts';
import { createFrameStats } from './frameStats.ts';
import type { Hand } from './landmarks.ts';
import type { OneEuroParams } from './oneEuro.ts';
import { loadPoseModel, type Delegate } from './pose.ts';
import { createPoseSmoother } from './poseSmoother.ts';
import type { SensingFrame } from './sensingFrame.ts';

/**
 * Sensing: camera → pose inference → smoothing, once per new camera frame,
 * outside the render loop. Consumers subscribe to `SensingFrame`s or read
 * `latest` from their own loop; they never touch the camera or MediaPipe.
 *
 * Inference runs synchronously on the main thread inside the camera's frame
 * callback (not in requestAnimationFrame), so the render loop never waits on
 * it. If that ever stutters rendering, move it to a Web Worker (SPEC).
 */
export interface Sensing {
  /** The live, unmirrored camera video (see `Camera.video` for showing it). */
  readonly video: HTMLVideoElement;
  /** Delegate running pose inference ('CPU' after a GPU failure). */
  readonly delegate: Delegate;
  /** The most recent frame, or null before the first one. */
  readonly latest: SensingFrame | null;
  readonly hand: Hand;
  /** Change the hitting hand; takes effect from the next frame. */
  setHand(hand: Hand): void;
  /** Called once per processed camera frame. Returns an unsubscribe function. */
  subscribe(listener: (frame: SensingFrame) => void): () => void;
  /** Release the camera and the model. */
  stop(): void;
}

export interface SensingOptions {
  /** Hitting hand; default right until the handedness prompt exists. */
  hand?: Hand;
  /** One Euro parameters, read every frame; default reads the live knobs. */
  oneEuro?: () => OneEuroParams;
}

const knobParams = (): OneEuroParams => ({ minCutoff: ONE_EURO_MIN_CUTOFF.value, beta: ONE_EURO_BETA.value });

/** Asks for the camera, loads the pose model, and starts emitting frames. */
export async function startSensing(options: SensingOptions = {}): Promise<Sensing> {
  const [cameraResult, modelResult] = await Promise.allSettled([openCamera(), loadPoseModel()]);
  if (cameraResult.status === 'rejected' || modelResult.status === 'rejected') {
    // Release whichever half did start.
    if (cameraResult.status === 'fulfilled') cameraResult.value.stop();
    if (modelResult.status === 'fulfilled') modelResult.value.close();
    throw cameraResult.status === 'rejected' ? cameraResult.reason : (modelResult as PromiseRejectedResult).reason;
  }
  const camera = cameraResult.value;
  const model = modelResult.value;
  const smoother = createPoseSmoother({ params: options.oneEuro ?? knobParams, hand: options.hand ?? 'right' });
  const stats = createFrameStats();
  const listeners = new Set<(frame: SensingFrame) => void>();
  let latest: SensingFrame | null = null;

  camera.start(({ t, timeSource, presentedFrames }) => {
    const started = performance.now();
    const landmarks = model.detect(camera.video, t);
    const inferenceMs = performance.now() - started;
    stats.record({ t, inferenceMs, presentedFrames });
    const frame: SensingFrame = {
      t,
      timeSource,
      hand: smoother.hand,
      landmarks,
      ...smoother.update(t, landmarks),
      inferenceMs,
      cameraFps: stats.cameraFps,
      poseFps: stats.poseFps,
    };
    latest = frame;
    for (const listener of listeners) {
      try {
        listener(frame);
      } catch (error) {
        console.error('Sensing listener failed', error);
      }
    }
  });

  return {
    video: camera.video,
    get delegate() {
      return model.delegate;
    },
    get latest() {
      return latest;
    },
    get hand() {
      return smoother.hand;
    },
    setHand: (hand) => smoother.setHand(hand),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    stop() {
      camera.stop();
      model.close();
      listeners.clear();
    },
  };
}

let shared: Promise<Sensing> | null = null;

/**
 * The page-wide sensing instance, started on first call. The debug overlay
 * and the game share it so the camera is opened once. If starting fails
 * (e.g. permission denied), the next call tries again.
 */
export function sharedSensing(): Promise<Sensing> {
  shared ??= startSensing().catch((error: unknown) => {
    shared = null;
    throw error;
  });
  return shared;
}
