import { hittingSide, type Hand, type Point2 } from '../sensing/landmarks.ts';
import { startSensing } from '../sensing/sensing.ts';
import type { SensingFrame } from '../sensing/sensingFrame.ts';

/**
 * Latency harness (SPEC "Latency harness, calibration and detection test"):
 * a separate page (`latency.html`, not linked from the game) that shows the
 * mirrored camera video full screen with one bright dot on the tracked wrist
 * and nothing else over the video, so a phone filming the screen and the real
 * hand in slow motion can count the frames between them.
 *
 * URL params: `?hand=left` (default right), `?raw` draws the unsmoothed
 * MediaPipe wrist instead of the smoothed one.
 *
 * The dot uses the smoothed wrist by default because that is what the game
 * uses, so the measured delay includes the One Euro filter's lag. `?raw`
 * separates the filter's share from the camera + inference share.
 */

const params = new URLSearchParams(window.location.search);
const hand: Hand = params.get('hand') === 'left' ? 'left' : 'right';
const useRaw = params.has('raw');
const READOUT_INTERVAL_MS = 250;
const DOT_SIZE = 28;

document.head.append(
  Object.assign(document.createElement('style'), {
    textContent: `
.stage { position: fixed; left: 50%; top: 50%; background: #000; }
.stage video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; transform: scaleX(-1); }
.dot { position: absolute; left: 0; top: 0; width: ${DOT_SIZE}px; height: ${DOT_SIZE}px; margin: -${DOT_SIZE / 2}px 0 0 -${DOT_SIZE / 2}px;
  border-radius: 50%; background: #ff00ff; will-change: transform; display: none; }
.readout { position: fixed; right: 6px; bottom: 6px; padding: 2px 6px; border-radius: 4px; white-space: pre;
  background: rgba(0,0,0,0.55); color: #cfd6e4; font: 11px/1.3 ui-monospace, Menlo, monospace; }
`,
  }),
);

const readout = document.createElement('div');
readout.className = 'readout';
readout.textContent = 'Starting camera and pose model… (video stays on this device)';
document.body.append(readout);

const fmt = (n: number | null) => (n === null ? '–' : n.toFixed(1));

function rawWrist(frame: SensingFrame): Point2 | null {
  const landmark = frame.landmarks?.[hittingSide(frame.hand).wrist];
  return landmark ?? null;
}

try {
  const sensing = await startSensing({ hand });
  const stage = document.createElement('div');
  stage.className = 'stage';
  const dot = document.createElement('div');
  dot.className = 'dot';
  sensing.video.style.cssText = '';
  stage.append(sensing.video, dot);
  document.body.prepend(stage);

  /** Fit the stage to the video's aspect ratio inside the window, so dot maths stays exact. */
  let stageWidth = 0;
  let stageHeight = 0;
  function layout(): void {
    const { videoWidth, videoHeight } = sensing.video;
    if (!videoWidth) return;
    const scale = Math.min(window.innerWidth / videoWidth, window.innerHeight / videoHeight);
    stageWidth = videoWidth * scale;
    stageHeight = videoHeight * scale;
    stage.style.width = `${stageWidth}px`;
    stage.style.height = `${stageHeight}px`;
    stage.style.margin = `${-stageHeight / 2}px 0 0 ${-stageWidth / 2}px`;
  }
  window.addEventListener('resize', layout);

  let lastReadout = -Infinity;
  sensing.subscribe((frame) => {
    if (!stageWidth) layout();
    const wrist = useRaw ? rawWrist(frame) : frame.wrist;
    if (wrist) {
      dot.style.display = 'block';
      dot.style.transform = `translate(${(1 - wrist.x) * stageWidth}px, ${wrist.y * stageHeight}px)`;
    } else {
      dot.style.display = 'none';
    }
    if (frame.t - lastReadout >= READOUT_INTERVAL_MS) {
      lastReadout = frame.t;
      readout.textContent =
        `camera ${fmt(frame.cameraFps)} fps · ${hand} · ${useRaw ? 'raw' : 'smoothed'}\n` +
        `inference ${fmt(frame.meanInferenceMs)} ms avg (${sensing.delegate})\n` +
        `capture→result ${fmt(frame.processedAt - frame.t)} ms`;
    }
  });
} catch (error) {
  readout.textContent = `Camera unavailable: ${error instanceof Error ? error.message : String(error)}`;
}
