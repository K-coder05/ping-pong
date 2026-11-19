/**
 * Webcam capture (SPEC "Camera"): 640×480, ideally 60 FPS, with a callback
 * once per new camera frame via `requestVideoFrameCallback`, so each frame is
 * processed exactly once and never inside the render loop.
 */

/**
 * Which rVFC timestamp a frame time came from: `'capture'` is
 * `metadata.captureTime` (when the camera captured it); `'presentation'` is
 * the fallback `metadata.presentationTime` when the browser omits capture
 * time (a little later than capture).
 */
export type TimeSource = 'capture' | 'presentation';

export interface CameraFrame {
  /**
   * When the camera captured the frame, ms on the `performance.now()` clock:
   * `metadata.captureTime` when the browser provides it, else
   * `metadata.presentationTime` (see `timeSource`).
   */
  t: number;
  timeSource: TimeSource;
  /** Running count of frames the video element has shown, including ones no callback saw. */
  presentedFrames: number;
}

export interface Camera {
  /**
   * The live video, unmirrored. It starts parked in the page, invisible, so
   * the browser keeps delivering frames; move it into a visible container to
   * show it, and call `parkVideo` to hide it again.
   */
  readonly video: HTMLVideoElement;
  /** Start calling `onFrame` once per new camera frame. Call once. */
  start(onFrame: (frame: CameraFrame) => void): void;
  /** Stop frame callbacks and release the camera. */
  stop(): void;
}

const PARKED_STYLE =
  'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1';

/** Hide the video without removing it from the page (detached videos may stop delivering frames). */
export function parkVideo(video: HTMLVideoElement): void {
  video.style.cssText = PARKED_STYLE;
  document.body.append(video);
}

/** Asks for camera permission and starts the stream. Rejects if denied or unavailable. */
export async function openCamera(): Promise<Camera> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera access needs a secure page (https or localhost) in a current browser');
  }
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
    throw new Error('This browser lacks requestVideoFrameCallback; use a current Chrome, Edge, Safari or Firefox');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, frameRate: { ideal: 60 } },
    audio: false,
  });

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  parkVideo(video);
  try {
    await video.play();
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    video.remove();
    throw error;
  }

  let handle: number | null = null;
  let onFrame: ((frame: CameraFrame) => void) | null = null;

  const tick: VideoFrameRequestCallback = (_now, metadata) => {
    handle = video.requestVideoFrameCallback(tick);
    const capture = metadata.captureTime;
    try {
      onFrame?.({
        t: capture ?? metadata.presentationTime,
        timeSource: capture === undefined ? 'presentation' : 'capture',
        presentedFrames: metadata.presentedFrames,
      });
    } catch (error) {
      // One bad frame must not end the frame loop.
      console.error('Camera frame handler failed', error);
    }
  };

  return {
    video,
    start(listener) {
      if (onFrame) throw new Error('Camera already started');
      onFrame = listener;
      handle = video.requestVideoFrameCallback(tick);
    },
    stop() {
      if (handle !== null) video.cancelVideoFrameCallback(handle);
      handle = null;
      onFrame = null;
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
      video.remove();
    },
  };
}
