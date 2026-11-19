import { ONE_EURO_BETA, ONE_EURO_MIN_CUTOFF } from '../game/constants.ts';
import { openCamera } from './camera.ts';
import { createFrameStats } from './frameStats.ts';
import type { Hand } from './landmarks.ts';
import { loadPoseModel, type Delegate } from './pose.ts';
import { createPoseSmoother } from './poseSmoother.ts';
import type { SensingFrame } from './sensingFrame.ts';

/**
 * Sensing: camera → pose inference → smoothing, once per new camera frame.
 * Consumers subscribe to `SensingFrame`s or read `latest` from their own
 * loop; they never touch the camera or MediaPipe.
 *
 * Inference is driven by the camera's frame callback, not by the render
 * loop: the game loop never calls or awaits it and simply reads the newest
 * frame. It does still run synchronously on the main thread, so a slow
 * `detectForVideo` delays the browser frame it lands in (see `inferenceMs`).
 * If that visibly stutters rendering, move inference to a Web Worker (SPEC).
 *
 * Within the game page, use `sharedSensing()` from `shared.ts` so the
 * camera opens once; a separate page (e.g. the latency harness) may call
 * `startSensing()` directly.
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
}

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
  const smoother = createPoseSmoother({
    params: () => ({ minCutoff: ONE_EURO_MIN_CUTOFF.value, beta: ONE_EURO_BETA.value }), // live knobs
    hand: options.hand ?? 'right',
  });
  const stats = createFrameStats();
  const listeners = new Set<(frame: SensingFrame) => void>();
  let latest: SensingFrame | null = null;

  camera.start(({ t, timeSource, presentedFrames }) => {
    const started = performance.now();
    const landmarks = model.detect(camera.video, t);
    const inferenceMs = performance.now() - started;
    stats.record({ t, inferenceMs, presentedFrames });
    const smoothed = smoother.update(t, landmarks);
    const frame: SensingFrame = {
      t,
      timeSource,
      hand: smoother.hand,
      landmarks,
      ...smoothed,
      inferenceMs,
      meanInferenceMs: stats.inferenceMs ?? inferenceMs,
      processedAt: performance.now(),
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
