import { handedness } from '../game/handedness.ts';
import { swingInputMode } from '../input/mouseInput.ts';
import { createPoseInput } from '../input/poseInput.ts';
import type { SwingSource } from '../input/types.ts';
import { hittingSide, type Hand, type Point2 } from '../sensing/landmarks.ts';
import { startSensing } from '../sensing/sensing.ts';
import type { SensingFrame } from '../sensing/sensingFrame.ts';
import { createSwingFlash } from './swingFlash.ts';
import { installToolPhone, PHONE_STEP_TEXT } from './toolPhone.ts';

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
 *
 * Flash test (docs/specs/p3.md, P3-d), `?flash`: a black screen that flashes
 * white the instant a Swing Onset is detected, for either Input: the Camera
 * by default (the game's pose Swing detector), the Phone with
 * `&input=phone` (pairing, Zeroing, then the game's Phone Input with clock
 * sync; `L` shows the link overlay). Film the hand and the screen together in
 * slow motion and count the frames from the hand starting to move to the
 * flash. The hand is `?hand=` if given, else the saved one, else right.
 */

const params = new URLSearchParams(window.location.search);
const flashMode = params.has('flash');
const phoneMode = swingInputMode(window.location.search) === 'phone';
const handParam = params.get('hand');
const hand: Hand = handParam === 'left' || handParam === 'right' ? handParam : flashMode ? (handedness.hand ?? 'right') : 'right';
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
.readout { position: fixed; right: 6px; bottom: 6px; z-index: 20; padding: 2px 6px; border-radius: 4px; white-space: pre;
  background: rgba(0,0,0,0.55); color: #cfd6e4; font: 11px/1.3 ui-monospace, Menlo, monospace; }
.flash { position: fixed; inset: 0; z-index: 10; background: #fff; visibility: hidden; pointer-events: none; }
.preview { position: fixed; left: 6px; bottom: 6px; z-index: 5; width: 160px; height: auto; opacity: 0.6; transform: scaleX(-1); }
.pairing-panel { position: fixed; inset: 0; z-index: 5; display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: #0c0e14; color: #e6e9ef; font-family: system-ui, sans-serif; }
`,
  }),
);

const readout = document.createElement('div');
readout.className = 'readout';
document.body.append(readout);

const fmt = (n: number | null) => (n === null ? '–' : n.toFixed(1));

function rawWrist(frame: SensingFrame): Point2 | null {
  const landmark = frame.landmarks?.[hittingSide(frame.hand).wrist];
  return landmark ?? null;
}

/** The wrist dot over the camera video (the harness without `?flash`). */
async function wristDot(): Promise<void> {
  readout.textContent = 'Starting camera and pose model… (video stays on this device)';
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
}

/**
 * The flash test: the screen goes white the instant a Swing Onset is
 * detected (`swingFlash.ts` decides; this only paints). Apart from the small
 * readout (and the Camera's framing preview) the screen stays black.
 */
async function flashTest(): Promise<void> {
  const now = () => performance.now();
  const flashEl = Object.assign(document.createElement('div'), { className: 'flash' });
  document.body.append(flashEl);
  const flash = createSwingFlash();
  let offTimer: ReturnType<typeof setTimeout> | undefined;
  const paint = () => {
    flashEl.style.visibility = flash.isOn(now()) ? 'visible' : 'hidden';
  };
  const flashOn = (swings: SwingSource) =>
    swings.subscribe((swing) => {
      flash.onset(swing, now());
      paint(); // inside the Swing's own callback: the next frame the browser paints shows it
      clearTimeout(offTimer);
      offTimer = setTimeout(paint, Math.max(0, (flash.offAt ?? 0) - now()));
    });
  const swingsLine = () =>
    `${flash.swings} Swing${flash.swings === 1 ? '' : 's'} · last recognised ${fmt(flash.lastDetectMs)} ms after its Onset time`;

  if (phoneMode) {
    const pairingPanel = Object.assign(document.createElement('div'), { className: 'pairing-panel' });
    document.body.append(pairingPanel);
    const phone = installToolPhone({ pairingParent: pairingPanel, now, hand: () => hand });
    flashOn(phone.input);
    const show = () => {
      readout.textContent = `Flash test · Phone · ${hand}\n${PHONE_STEP_TEXT[phone.step()]}\n${swingsLine()}\nL: link overlay`;
    };
    phone.onChange(show);
    phone.input.subscribe(show);
    show();
    return;
  }

  readout.textContent = 'Flash test · Camera\nStarting camera and pose model… (video stays on this device)';
  const sensing = await startSensing({ hand });
  // A small preview for framing; the flash covers it.
  sensing.video.style.cssText = '';
  sensing.video.className = 'preview';
  document.body.append(sensing.video);
  const input = createPoseInput(sensing, {
    aspect: () => {
      const { videoWidth, videoHeight } = sensing.video;
      return videoWidth && videoHeight ? videoWidth / videoHeight : 4 / 3;
    },
  });
  flashOn(input);
  let lastReadout = -Infinity;
  sensing.subscribe((frame) => {
    if (frame.t - lastReadout < READOUT_INTERVAL_MS) return;
    lastReadout = frame.t;
    readout.textContent = `Flash test · Camera · ${hand}\nwrist ${frame.wrist ? 'tracked' : 'not seen'} · camera ${fmt(frame.cameraFps)} fps\n${swingsLine()}`;
  });
}

(flashMode ? flashTest() : wristDot()).catch((error: unknown) => {
  readout.textContent = `Camera unavailable: ${error instanceof Error ? error.message : String(error)}`;
});
