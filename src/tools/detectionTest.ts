import { TRACKING_MIN_VISIBILITY } from '../game/constants.ts';
import { handedness } from '../game/handedness.ts';
import { timingOffsetStore } from '../game/timingOffsetStore.ts';
import { swingInputMode } from '../input/mouseInput.ts';
import { createPoseInput, type PoseInput } from '../input/poseInput.ts';
import type { SwingSource } from '../input/types.ts';
import { createPhoneLogRecorder } from '../phone/phoneLog.ts';
import { askHandedness } from '../render/handednessPrompt.ts';
import { createFrameLog } from '../sensing/frameLog.ts';
import type { Hand } from '../sensing/landmarks.ts';
import { startSensing, type Sensing } from '../sensing/sensing.ts';
import { frameLogRow, type SensingFrame } from '../sensing/sensingFrame.ts';
import { IDLE_MS } from './detectionScore.ts';
import { createDetectionRun } from './detectionRun.ts';
import { createMetronome } from './metronome.ts';
import { createMetronomePresentation } from './metronomePresentation.ts';
import { installToolPhone, PHONE_STEP_TEXT, type ToolPhone } from './toolPhone.ts';

/**
 * Detection test (SPEC "Detection test"): a separate page (`detection.html`,
 * not linked from the game), run once per tester. 20 metronome ticks to swing
 * on, then 60 s of standing and talking; the results are detected/20 and
 * false triggers per minute.
 *
 * Either Input (docs/specs/p3.md, P3-d), scored the same way
 * (`detectionRun.ts` → `scoreSession`):
 *
 * - Camera (default): the game's pose Swing detector; the per-frame CSV for
 *   the session; judged with the saved Timing Offset.
 * - Phone (`?input=phone`): pairing, Zeroing, then the game's Phone Input with
 *   clock sync (`L` shows the link overlay); the run's Phone log (JSONL) to
 *   download. The Phone has no saved Timing Offset yet, so its Swings are
 *   judged against the raw tick.
 */

const TICK_COUNT = 20;
const TICK_INTERVAL_MS = 1800;
const LEAD_IN_MS = 3000;
/** Wait this long after the idle phase ends for the last frames' Onsets to arrive. */
const SETTLE_MS = 400;
const DEFAULT_ASPECT = 4 / 3;
/** How long each detected Swing stays on screen. */
const SWING_FLAG_MS = 600;

const phoneMode = swingInputMode(window.location.search) === 'phone';
const now = () => performance.now();

document.head.append(
  Object.assign(document.createElement('style'), {
    textContent: `
.dt { max-width: 720px; margin: 0 auto; padding: 16px; box-sizing: border-box; }
.dt h1 { font-size: 22px; margin: 0 0 8px; }
.dt .stage { position: relative; background: #000; aspect-ratio: 4 / 3; width: 100%; border-radius: 8px; overflow: hidden; }
.dt .stage video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; transform: scaleX(-1); }
.dt .flash { position: absolute; inset: 0; background: #fff; opacity: 0; pointer-events: none; }
.dt .flash[data-tick] { opacity: 0.85; }
.dt .stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.dt .swing-flag { position: absolute; right: 8px; bottom: 8px; padding: 4px 10px; border-radius: 6px; background: #ff4fa3; color: #fff; font-size: 22px; font-weight: 600; }
.dt .banner { position: absolute; left: 0; right: 0; top: 0; padding: 8px 12px; background: rgba(0,0,0,0.6); font-size: 20px; text-align: center; }
.dt .pairing-panel { position: absolute; inset: 0; overflow: auto; background: #0c0e14; }
.dt .phone-step { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; font-size: 24px; }
.dt .panel { margin: 12px 0; }
.dt button { font: inherit; padding: 10px 18px; border-radius: 6px; cursor: pointer; margin-right: 8px; }
.dt .big { font-size: 28px; margin: 4px 0; }
.dt .muted { color: #9aa4b5; font-size: 14px; }
`,
  }),
);

const root = document.createElement('main');
root.className = 'dt';
document.body.append(root);

const title = Object.assign(document.createElement('h1'), { textContent: `Detection test · ${phoneMode ? 'Phone' : 'Camera'}` });
const stage = Object.assign(document.createElement('div'), { className: 'stage' });
const flash = Object.assign(document.createElement('div'), { className: 'flash' });
/** Wrist dot over the mirrored video, so testers can see they're tracked. */
const wristCanvas = document.createElement('canvas');
/** Shows each detected Swing for a moment, so testers can see what counted. */
const swingFlag = Object.assign(document.createElement('div'), { className: 'swing-flag' });
swingFlag.hidden = true;
const banner = Object.assign(document.createElement('div'), { className: 'banner' });
banner.hidden = true;
const panel = Object.assign(document.createElement('div'), { className: 'panel' });
root.append(title, stage, panel);

function button(label: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const element = Object.assign(document.createElement('button'), { type: 'button', textContent: label, disabled });
  element.addEventListener('click', onClick);
  return element;
}

function show(...nodes: (Node | string)[]): void {
  panel.replaceChildren(...nodes);
}

function paragraph(text: string, className = ''): HTMLParagraphElement {
  return Object.assign(document.createElement('p'), { textContent: text, className });
}

/** The smoothed hitting wrist as a dot, mirrored like the video; hollow while barely visible. */
function drawWrist(canvas: HTMLCanvasElement, sensing: Sensing, frame: SensingFrame): void {
  const { videoWidth, videoHeight } = sensing.video;
  if (videoWidth && (canvas.width !== videoWidth || canvas.height !== videoHeight)) {
    canvas.width = videoWidth;
    canvas.height = videoHeight;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!frame.wrist) return;
  ctx.beginPath();
  ctx.arc((1 - frame.wrist.x) * canvas.width, frame.wrist.y * canvas.height, 12, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ff4fa3';
  ctx.fillStyle = '#ff4fa3';
  if (frame.wristVisibility >= TRACKING_MIN_VISIBILITY.value) ctx.fill();
  ctx.stroke();
}

function download(text: string, type: string, extension: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `detection-test-${phoneMode ? 'phone' : 'camera'}-${new Date().toISOString().replaceAll(':', '-')}.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The Camera's Swings, with the per-frame CSV. */
async function cameraInput(): Promise<{ swings: PoseInput; sensing: Sensing } | null> {
  show(paragraph('Starting camera and pose model… (video stays on this device)'));
  let sensing: Sensing;
  try {
    sensing = await startSensing({ hand: handedness.hand ?? 'right' });
  } catch (error) {
    show(paragraph(`Camera unavailable: ${error instanceof Error ? error.message : String(error)}`));
    return null;
  }
  sensing.video.style.cssText = '';
  stage.append(sensing.video, wristCanvas, flash, banner, swingFlag);
  const swings = createPoseInput(sensing, {
    aspect: () => {
      const { videoWidth, videoHeight } = sensing.video;
      return videoWidth && videoHeight ? videoWidth / videoHeight : DEFAULT_ASPECT;
    },
  });
  return { swings, sensing };
}

async function main(): Promise<void> {
  let hand: Hand = handedness.hand ?? 'right';
  let sensing: Sensing | null = null;
  let poseInput: PoseInput | null = null;
  let phone: ToolPhone | null = null;
  let swings: SwingSource;
  const phoneStepEl = Object.assign(document.createElement('div'), { className: 'phone-step' });

  if (phoneMode) {
    const pairingPanel = Object.assign(document.createElement('div'), { className: 'pairing-panel' });
    stage.append(phoneStepEl, pairingPanel, flash, banner, swingFlag);
    phone = installToolPhone({ pairingParent: pairingPanel, now, hand: () => hand });
    swings = phone.input;
  } else {
    const camera = await cameraInput();
    if (!camera) return;
    ({ swings: poseInput, sensing } = camera);
    swings = poseInput;
  }

  hand = handedness.hand ?? (await askHandedness());
  handedness.set(hand);
  sensing?.setHand(hand);

  const run = createDetectionRun(swings);
  let log = createFrameLog();
  let phoneLog = createPhoneLogRecorder();
  let lastFrameT = -Infinity;
  let idle = { start: 0, end: 0 };
  /** The Timing Offset this run is judged with, read at Start. */
  let timingOffsetMs = 0;

  /** The Input whose saved Timing Offset a run is judged with. */
  const input = phoneMode ? 'phone' : 'camera';

  /** The Timing Offset a run is judged with: the saved one for this Input, else none. */
  const timingOffset = (): number => timingOffsetStore.offsetMsFor(input) ?? 0;

  /** Which Timing Offset a run will use (or used), for the setup and results screens. */
  const offsetNote = (): string => {
    const saved = timingOffsetStore.offsetMsFor(input);
    return saved === null
      ? 'No Timing Offset saved: run Timing calibration in the game first, or Swings are judged against the raw tick.'
      : `Judged with your saved Timing Offset: ${Math.round(saved)} ms (each tick's ±300 ms window starts that much later).`;
  };

  let hideFlag: ReturnType<typeof setTimeout> | undefined;
  swings.subscribe((swing) => {
    swingFlag.textContent = swing.side === 'forehand' ? 'Forehand!' : 'Backhand!';
    swingFlag.hidden = false;
    clearTimeout(hideFlag);
    hideFlag = setTimeout(() => (swingFlag.hidden = true), SWING_FLAG_MS);
  });

  const recording = () => run.phase === 'ticks' || run.phase === 'idle';
  if (phone) {
    const p = phone;
    p.link.onPacket((packet, tRecv) => {
      if (recording()) phoneLog.record(packet, tRecv);
    });
    p.link.onControl((m, tRecv) => {
      if (recording() && m.type === 'zero') phoneLog.zero(tRecv);
    });
    const showStep = () => {
      phoneStepEl.textContent = PHONE_STEP_TEXT[p.step()];
      if (run.phase === 'setup') intro(); // Start waits for the Phone to be Zeroed
    };
    p.onChange(showStep);
    phoneStepEl.textContent = PHONE_STEP_TEXT[p.step()];
  }

  if (sensing && poseInput) {
    const camera = sensing;
    const pose = poseInput;
    camera.subscribe((frame) => {
      drawWrist(wristCanvas, camera, frame);
      if (!recording()) return;
      const reading = pose.read(frame);
      const tickTimes = run.tickTimes;
      let tick: number | null = null;
      // A tick belongs to the first frame captured at or after its time.
      for (let i = 0; i < tickTimes.length; i++) {
        const time = tickTimes[i]!;
        if (time > lastFrameT && time <= frame.t) tick = i;
      }
      lastFrameT = frame.t;
      log.push({
        ...frameLogRow(frame),
        phase: run.phase,
        tick,
        // Exact tick time: the frame is up to one frame later (log replay, #12).
        tickTime: tick === null ? null : tickTimes[tick],
        px: reading?.p.x ?? null,
        py: reading?.p.y ?? null,
        u: reading?.u ?? null,
        s: reading?.s ?? null,
        sStroke: reading?.sStroke ?? null,
        vertSpeed: reading?.vertSpeed ?? null,
        side: reading?.side ?? null,
        onset: reading ? (reading.swing ? 1 : 0) : null,
      });
    });
  }

  const presentation = createMetronomePresentation({ flashElement: flash });
  const metronome = createMetronome({
    count: TICK_COUNT,
    intervalMs: TICK_INTERVAL_MS,
    leadInMs: LEAD_IN_MS,
    onSchedule: presentation.callbacks.onSchedule,
    onTick(index, time) {
      presentation.callbacks.onTick(index, time);
      banner.textContent = `Swing now! ${index + 1} / ${TICK_COUNT}`;
    },
    onEnd: startIdle,
  });

  const changeHand = () =>
    void askHandedness().then((h) => {
      hand = h;
      handedness.set(h);
      sensing?.setHand(h);
      intro();
    });

  function intro(): void {
    run.reset();
    banner.hidden = true;
    const phoneReady = !phone || phone.step() === 'ready';
    show(
      paragraph(phoneMode ? 'Hold the Phone in your hitting hand, gripped firmly, with space around you.' : 'Stand back until your whole swing fits in the picture.', 'big'),
      paragraph(
        `Part 1: ${TICK_COUNT} ticks (flash and click). Swing once on each tick, like a forehand or backhand return. ` +
          `Part 2: then stand still and talk normally for ${IDLE_MS / 1000} s without swinging.` +
          (phoneMode ? ' Keep holding the Phone.' : ' Video stays on this device.'),
        'muted',
      ),
      paragraph(offsetNote(), 'muted'),
      ...(phoneReady ? [] : [paragraph(`Start unlocks once the Phone is Zeroed. ${PHONE_STEP_TEXT[phone!.step()]}`, 'muted')]),
      button('Start', () => void begin(), !phoneReady),
      button(`Hand: ${hand} (change)`, changeHand),
    );
  }

  async function begin(): Promise<void> {
    await presentation.unlock().catch(() => undefined); // silent if audio is unavailable; the flash still works
    log = createFrameLog();
    phoneLog = createPhoneLogRecorder();
    lastFrameT = -Infinity;
    banner.hidden = false;
    banner.textContent = 'Get ready…';
    show(paragraph(`Swing on every tick. ${TICK_COUNT} ticks, one every ${(TICK_INTERVAL_MS / 1000).toFixed(1)} s.`));
    timingOffsetMs = timingOffset();
    metronome.start();
    run.begin(metronome.tickTimes, timingOffsetMs);
  }

  function startIdle(): void {
    idle = run.startIdle();
    banner.textContent = 'Relax: arm down, stand and talk normally';
    show(paragraph('Idle phase: every detected swing counts as a false trigger.', 'muted'));
    const countdown = setInterval(() => {
      const left = Math.max(0, Math.ceil((idle.end - now()) / 1000));
      banner.textContent = `Stand and talk normally. Don't swing. ${left} s`;
      if (now() >= idle.end + SETTLE_MS) {
        clearInterval(countdown);
        finish();
      }
    }, 200);
  }

  function finish(): void {
    const score = run.finish();
    banner.hidden = true;
    show(
      paragraph(`Detected: ${score.detected} / ${score.total}`, 'big'),
      paragraph(`False triggers: ${score.falseTriggersPerMinute.toFixed(1)} per minute (${score.falseTriggers} in ${IDLE_MS / 1000} s)`, 'big'),
      phoneMode
        ? paragraph(`Phone · hand: ${hand} · Timing Offset: ${Math.round(timingOffsetMs)} ms`, 'muted')
        : paragraph(`${log.length} frames logged · hand: ${hand} · Timing Offset: ${Math.round(timingOffsetMs)} ms`, 'muted'),
      phoneMode
        ? button('Download Phone log', () => download(phoneLog.toJsonl(), 'application/x-ndjson', 'jsonl'))
        : button('Download CSV', () => download(log.toCsv(), 'text/csv', 'csv')),
      button('Run again', intro),
    );
  }

  intro();
}

void main();
