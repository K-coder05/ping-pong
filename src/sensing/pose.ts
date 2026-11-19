import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { PoseLandmark } from './landmarks.ts';

/**
 * MediaPipe Pose Landmarker (lite model, VIDEO mode) behind a small interface.
 * Model and wasm load from CDNs (SPEC "Pose Landmarker setup"), so they work
 * whatever base path the page is served from.
 */

/**
 * Must match the installed `@mediapipe/tasks-vision` version: the JS API and
 * its wasm runtime are released together (a test checks this).
 */
export const WASM_BASE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm';
export const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

export type Delegate = 'GPU' | 'CPU';

export interface PoseModel {
  /** The delegate currently running inference. */
  readonly delegate: Delegate;
  /**
   * Run inference on the frame the video is showing now. `timestampMs` must
   * increase from call to call (it is nudged forward if it doesn't). Returns
   * the 33 landmarks of the one tracked person, or null if none was found.
   */
  detect(video: HTMLVideoElement, timestampMs: number): PoseLandmark[] | null;
  close(): void;
}

async function createLandmarker(delegate: Delegate): Promise<PoseLandmarker> {
  const vision = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
  return PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate },
    runningMode: 'VIDEO', // ordered frames, increasing timestamps
    numPoses: 1,
  });
}

/**
 * Loads the model on the GPU delegate, falling back to CPU if the GPU
 * delegate fails to load or fails on its first inference.
 */
export async function loadPoseModel(): Promise<PoseModel> {
  let delegate: Delegate = 'GPU';
  let landmarker: PoseLandmarker | null;
  try {
    landmarker = await createLandmarker('GPU');
  } catch (error) {
    console.warn('Pose: GPU delegate failed to load, using CPU', error);
    delegate = 'CPU';
    landmarker = await createLandmarker('CPU');
  }

  let lastTimestamp = -Infinity;
  let succeededOnce = false;
  let closed = false;

  function fallBackToCpu(error: unknown): void {
    console.warn('Pose: GPU inference failed, switching to CPU', error);
    landmarker?.close();
    landmarker = null; // frames are skipped until the CPU model is ready
    delegate = 'CPU';
    createLandmarker('CPU').then(
      (cpu) => {
        if (closed) return cpu.close();
        landmarker = cpu;
        lastTimestamp = -Infinity; // a fresh landmarker has its own timestamp history
      },
      (cpuError: unknown) => console.error('Pose: CPU delegate failed to load too', cpuError),
    );
  }

  return {
    get delegate() {
      return delegate;
    },
    detect(video, timestampMs) {
      if (!landmarker) return null;
      // VIDEO mode rejects a timestamp that does not increase.
      const timestamp = Math.max(timestampMs, lastTimestamp + 1);
      lastTimestamp = timestamp;
      try {
        const result = landmarker.detectForVideo(video, timestamp);
        succeededOnce = true;
        return result.landmarks[0] ?? null;
      } catch (error) {
        if (delegate === 'GPU' && !succeededOnce) {
          fallBackToCpu(error);
          return null;
        }
        throw error;
      }
    },
    close() {
      closed = true;
      landmarker?.close();
      landmarker = null;
    },
  };
}
