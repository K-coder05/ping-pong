/**
 * Rolling camera and pose-inference statistics over the last few frames,
 * for the debug overlay readouts and the latency harness (SPEC "Latency
 * harness" step 5: inference cost and real camera FPS).
 */

export interface FrameSample {
  /** Frame timestamp, ms on the performance.now() clock. */
  t: number;
  /** Wall time `detectForVideo` took for this frame, ms. */
  inferenceMs: number;
  /**
   * The video element's running count of frames shown (rVFC
   * `metadata.presentedFrames`). It also counts frames that arrived while
   * inference was busy, so it gives the true camera rate.
   */
  presentedFrames?: number;
}

export interface FrameStats {
  record(sample: FrameSample): void;
  /** Real camera frame rate, or null until there are two frames. */
  readonly cameraFps: number | null;
  /** Frames actually run through pose inference per second, or null. */
  readonly poseFps: number | null;
  /** Mean inference time over the window, ms, or null before any frame. */
  readonly inferenceMs: number | null;
}

const DEFAULT_WINDOW = 30;

export function createFrameStats(windowSize = DEFAULT_WINDOW): FrameStats {
  const samples: FrameSample[] = [];

  /** Frames per second between the oldest and newest sample in the window. */
  function rate(framesBetween: (first: FrameSample, last: FrameSample) => number): number | null {
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first || !last || last.t <= first.t) return null;
    return (framesBetween(first, last) * 1000) / (last.t - first.t);
  }

  const processedFrames = () => samples.length - 1;

  return {
    record(sample) {
      samples.push(sample);
      if (samples.length > windowSize) samples.shift();
    },
    get cameraFps() {
      return rate((first, last) =>
        first.presentedFrames !== undefined && last.presentedFrames !== undefined
          ? last.presentedFrames - first.presentedFrames
          : processedFrames(),
      );
    },
    get poseFps() {
      return rate(processedFrames);
    },
    get inferenceMs() {
      if (samples.length === 0) return null;
      return samples.reduce((sum, s) => sum + s.inferenceMs, 0) / samples.length;
    },
  };
}
