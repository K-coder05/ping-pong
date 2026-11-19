import { TRACKING_MIN_VISIBILITY } from '../game/constants.ts';
import type { KnobRegistry } from '../game/knobs.ts';
import { parkVideo } from '../sensing/camera.ts';
import { createFrameLog, type CsvRow, type FrameLog } from '../sensing/frameLog.ts';
import { LANDMARK, sideOf, TRACKED_LANDMARKS, type Point2 } from '../sensing/landmarks.ts';
import type { Sensing } from '../sensing/sensing.ts';
import { frameLogRow, type SensingFrame } from '../sensing/sensingFrame.ts';
import { onSharedSensingStarted, sharedSensing } from '../sensing/shared.ts';

/**
 * Camera + pose debug overlay (SPEC "Debug overlay"): mirrored video, a dot
 * on each tracked landmark, the smoothed hitting wrist with its last 10
 * positions, camera FPS and inference time, and a CSV download of the
 * per-frame log.
 *
 * Open it from the debug panel (`D` → Camera → "Camera overlay") or load the
 * page with `?overlay`. The camera is only requested the first time it opens
 * (or when the game starts sensing). From then on every frame is logged, even
 * while the overlay is hidden, so you can play and download the log after.
 */

/** What an extension gets to draw with, once per frame while the overlay is visible. */
export interface OverlayView {
  /** Unmirrored context (identity transform), so text reads normally. */
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  frame: SensingFrame;
  /** Canvas pixel position of a normalized camera point, mirrored like the video. */
  toCanvas(point: Point2): Point2;
}

/**
 * Hook for later debug layers, e.g. the Swing detector's stroke-speed bar,
 * onset flash and extra log columns.
 */
export interface OverlayExtension {
  /** Draw on top of the landmarks. */
  draw?(view: OverlayView): void;
  /** Extra fields for this frame's log row (added as CSV columns). */
  logFields?(frame: SensingFrame): CsvRow;
}

const extensions = new Set<OverlayExtension>();

/**
 * Add a debug layer to the camera overlay. Works before or after the overlay
 * is installed. Returns a function that removes it.
 */
export function addOverlayExtension(extension: OverlayExtension): () => void {
  extensions.add(extension);
  return () => void extensions.delete(extension);
}

export interface CameraOverlay {
  readonly visible: boolean;
  /** Show the overlay, starting sensing (camera permission prompt) if needed. */
  show(): Promise<void>;
  hide(): void;
  toggle(): Promise<void>;
  readonly log: FrameLog;
}

const TRAIL_LENGTH = 10;
const READOUT_INTERVAL_MS = 250;

const COLOR = {
  hitting: '#ff9f43',
  other: '#4fc3f7',
  wrist: '#ffe14d',
} as const;
/** The wrist colour's RGB channels, for the fading trail. */
const TRAIL_RGB = '255, 225, 77';

const STYLE = `
.camera-overlay {
  position: fixed; left: 8px; bottom: 8px; z-index: 9;
  width: min(480px, calc(100vw - 16px)); box-sizing: border-box;
  padding: 6px; border-radius: 6px;
  background: rgba(12, 14, 20, 0.85); color: #e6e9ef;
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.camera-overlay[hidden] { display: none; }
.camera-overlay .stage { position: relative; width: 100%; aspect-ratio: 4 / 3; background: #000; }
.camera-overlay .stage > * { position: absolute; inset: 0; width: 100%; height: 100%; }
.camera-overlay .stage video { object-fit: fill; transform: scaleX(-1); }
.camera-overlay .status { position: absolute; inset: auto 0 0 0; height: auto; padding: 4px 6px; background: rgba(0,0,0,0.6); }
.camera-overlay .status:empty { display: none; }
.camera-overlay .readout { margin: 4px 0; white-space: pre-wrap; }
.camera-overlay .actions { display: flex; gap: 4px; }
.camera-overlay button { font: inherit; }
`;

/**
 * Builds the (hidden) overlay. `startSensing` is called when it is shown;
 * call `attach` with any sensing instance that starts, so its frames are
 * logged even if the overlay never opens.
 */
export function createCameraOverlay(startSensing: () => Promise<Sensing>): CameraOverlay & { attach(sensing: Sensing): void } {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.append(style);

  const root = document.createElement('section');
  root.className = 'camera-overlay';
  root.hidden = true;
  const stage = document.createElement('div');
  stage.className = 'stage';
  const canvas = document.createElement('canvas');
  const status = document.createElement('div');
  status.className = 'status';
  stage.append(canvas, status);
  const readout = document.createElement('div');
  readout.className = 'readout';
  const actions = document.createElement('div');
  actions.className = 'actions';
  root.append(stage, readout, actions);
  document.body.append(root);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');

  const log = createFrameLog();
  const trail: Point2[] = [];
  let sensing: Sensing | null = null;
  let lastReadout = -Infinity;

  actions.append(
    button('Download CSV', () => downloadCsv(log)),
    button('Clear log', () => {
      log.clear();
      lastReadout = -Infinity;
    }),
    button('Close', () => overlay.hide()),
  );

  function onFrame(frame: SensingFrame): void {
    let row = frameLogRow(frame);
    for (const extension of extensions) if (extension.logFields) row = { ...row, ...extension.logFields(frame) };
    log.push(row);

    if (frame.wrist) {
      trail.push(frame.wrist);
      if (trail.length > TRAIL_LENGTH) trail.shift();
    } else {
      trail.length = 0;
    }

    if (root.hidden) return;
    draw(frame);
    if (frame.t - lastReadout >= READOUT_INTERVAL_MS) {
      lastReadout = frame.t;
      readout.textContent = readoutText(frame);
    }
  }

  function draw(frame: SensingFrame): void {
    if (!ctx || !sensing) return;
    const { videoWidth, videoHeight } = sensing.video;
    if (videoWidth && (canvas.width !== videoWidth || canvas.height !== videoHeight)) {
      canvas.width = videoWidth;
      canvas.height = videoHeight;
      stage.style.aspectRatio = `${videoWidth} / ${videoHeight}`;
    }
    const { width, height } = canvas;
    const toCanvas = (p: Point2): Point2 => ({ x: (1 - p.x) * width, y: p.y * height });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);

    for (const name of TRACKED_LANDMARKS) {
      const landmark = frame.landmarks?.[LANDMARK[name]];
      if (!landmark) continue;
      const color = sideOf(name) === frame.hand ? COLOR.hitting : COLOR.other;
      dot(toCanvas(landmark), 5, color, landmark.visibility >= TRACKING_MIN_VISIBILITY);
    }

    trail.forEach((point, i) => {
      ctx.fillStyle = `rgba(${TRAIL_RGB}, ${((i + 1) / trail.length) * 0.6})`;
      const p = toCanvas(point);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3 + i * 0.3, 0, Math.PI * 2);
      ctx.fill();
    });
    if (frame.wrist) dot(toCanvas(frame.wrist), 8, COLOR.wrist, frame.wristVisibility >= TRACKING_MIN_VISIBILITY);

    for (const extension of extensions) extension.draw?.({ ctx, width, height, frame, toCanvas });
  }

  /** Filled when visible enough, hollow when not. */
  function dot(p: Point2, radius: number, color: string, filled: boolean): void {
    if (!ctx) return;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = filled ? '#000' : color;
    ctx.fillStyle = color;
    if (filled) ctx.fill();
    ctx.stroke();
  }

  function readoutText(frame: SensingFrame): string {
    const fmt = (n: number | null) => (n === null ? '–' : n.toFixed(1));
    const lost = frame.wristVisibility < TRACKING_MIN_VISIBILITY ? ' (lost)' : '';
    return [
      `camera ${fmt(frame.cameraFps)} fps · pose ${fmt(frame.poseFps)} fps`,
      `inference ${fmt(frame.meanInferenceMs)} ms avg (${sensing?.delegate ?? '?'}) · capture→result ${fmt(frame.processedAt - frame.t)} ms`,
      `${frame.hand} wrist visibility ${frame.wristVisibility.toFixed(2)}${lost} · t from ${frame.timeSource}`,
      `log ${log.length} frames`,
    ].join('\n');
  }

  const overlay = {
    get visible() {
      return !root.hidden;
    },
    attach(next: Sensing) {
      if (sensing === next) return;
      sensing = next;
      next.subscribe(onFrame);
    },
    async show() {
      root.hidden = false;
      status.textContent = sensing ? '' : 'Starting camera and pose model… (video stays on this device)';
      try {
        const started = await startSensing();
        overlay.attach(started);
        status.textContent = '';
        if (root.hidden) return; // closed while starting
        started.video.style.cssText = '';
        stage.prepend(started.video);
      } catch (error) {
        status.textContent = `Camera unavailable: ${error instanceof Error ? error.message : String(error)}`;
        throw error;
      }
    },
    hide() {
      root.hidden = true;
      if (sensing) parkVideo(sensing.video);
    },
    toggle() {
      if (root.hidden) return overlay.show();
      overlay.hide();
      return Promise.resolve();
    },
    log,
  };
  return overlay;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

function downloadCsv(log: FrameLog): void {
  const url = URL.createObjectURL(new Blob([log.toCsv()], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `sensing-log-${new Date().toISOString().replaceAll(':', '-')}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Adds the overlay to the game page: a "Camera overlay" button in the debug
 * panel's Camera group, and `?overlay` in the URL to open it on load. It logs
 * frames from the page's shared sensing as soon as anything starts it.
 */
export function installCameraOverlay(registry: KnobRegistry): CameraOverlay {
  const overlay = createCameraOverlay(sharedSensing);
  onSharedSensingStarted((sensing) => overlay.attach(sensing));
  const report = (error: unknown) => console.error('Camera overlay failed to start', error);
  registry.button({ name: 'Camera overlay', group: 'Camera', onPress: () => void overlay.toggle().catch(report) });
  if (new URLSearchParams(window.location.search).has('overlay')) void overlay.show().catch(report);
  return overlay;
}
