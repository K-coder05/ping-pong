import { handedness } from '../game/handedness.ts';
import { createPoseInput } from '../input/poseInput.ts';
import { askHandedness } from '../render/handednessPrompt.ts';
import { createFrameLog } from '../sensing/frameLog.ts';
import { startSensing, type Sensing } from '../sensing/sensing.ts';
import { frameLogRow } from '../sensing/sensingFrame.ts';
import { scoreSession, type SessionScore } from './detectionScore.ts';
import { createMetronome } from './metronome.ts';
import { createMetronomePresentation } from './metronomePresentation.ts';

/**
 * Detection test (SPEC "Detection test"): a separate page (`detection.html`,
 * not linked from the game), run once per tester. 20 metronome ticks to swing
 * on, then 60 s of standing and talking; the results are detected/20 and
 * false triggers per minute, with the per-frame CSV for the session.
 */

const TICK_COUNT = 20;
const TICK_INTERVAL_MS = 1800;
const LEAD_IN_MS = 3000;
/** Idle phase starts this long after the last tick, so its follow-through isn't a false trigger. */
const IDLE_GRACE_MS = 1500;
const IDLE_MS = 60_000;
/** Wait this long after the idle phase ends for the last frames' Onsets to arrive. */
const SETTLE_MS = 400;
const DEFAULT_ASPECT = 4 / 3;

document.head.append(
  Object.assign(document.createElement('style'), {
    textContent: `
.dt { max-width: 720px; margin: 0 auto; padding: 16px; box-sizing: border-box; }
.dt h1 { font-size: 22px; margin: 0 0 8px; }
.dt .stage { position: relative; background: #000; aspect-ratio: 4 / 3; width: 100%; border-radius: 8px; overflow: hidden; }
.dt .stage video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; transform: scaleX(-1); }
.dt .flash { position: absolute; inset: 0; background: #fff; opacity: 0; pointer-events: none; }
.dt .flash[data-tick] { opacity: 0.85; }
.dt .banner { position: absolute; left: 0; right: 0; top: 0; padding: 8px 12px; background: rgba(0,0,0,0.6); font-size: 20px; text-align: center; }
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

const title = Object.assign(document.createElement('h1'), { textContent: 'Detection test' });
const stage = Object.assign(document.createElement('div'), { className: 'stage' });
const flash = Object.assign(document.createElement('div'), { className: 'flash' });
const banner = Object.assign(document.createElement('div'), { className: 'banner' });
banner.hidden = true;
const panel = Object.assign(document.createElement('div'), { className: 'panel' });
root.append(title, stage, panel);

function button(label: string, onClick: () => void): HTMLButtonElement {
  const element = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
  element.addEventListener('click', onClick);
  return element;
}

function show(...nodes: (Node | string)[]): void {
  panel.replaceChildren(...nodes);
}

function paragraph(text: string, className = ''): HTMLParagraphElement {
  return Object.assign(document.createElement('p'), { textContent: text, className });
}

function downloadCsv(csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `detection-test-${new Date().toISOString().replaceAll(':', '-')}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

type Phase = 'setup' | 'ticks' | 'idle' | 'done';

async function main(): Promise<void> {
  show(paragraph('Starting camera and pose model… (video stays on this device)'));
  let sensing: Sensing;
  try {
    sensing = await startSensing({ hand: handedness.hand ?? 'right' });
  } catch (error) {
    show(paragraph(`Camera unavailable: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }
  sensing.video.style.cssText = '';
  stage.append(sensing.video, flash, banner);

  const hand = handedness.hand ?? (await askHandedness());
  handedness.set(hand);
  sensing.setHand(hand);

  const input = createPoseInput(sensing, {
    aspect: () => {
      const { videoWidth, videoHeight } = sensing.video;
      return videoWidth && videoHeight ? videoWidth / videoHeight : DEFAULT_ASPECT;
    },
  });

  // Session state, reset per run.
  let phase: Phase = 'setup';
  let log = createFrameLog();
  let onsets: number[] = [];
  let tickTimes: readonly number[] = [];
  let lastFrameT = -Infinity;
  let idle = { start: 0, end: 0 };

  input.subscribe((swing) => {
    if (phase === 'ticks' || phase === 'idle') onsets.push(swing.t);
  });

  sensing.subscribe((frame) => {
    if (phase === 'setup' || phase === 'done') return;
    const reading = input.read(frame);
    let tick: number | null = null;
    // A tick belongs to the first frame captured at or after its time.
    for (let i = 0; i < tickTimes.length; i++) {
      const time = tickTimes[i]!;
      if (time > lastFrameT && time <= frame.t) tick = i;
    }
    lastFrameT = frame.t;
    log.push({
      ...frameLogRow(frame),
      phase,
      tick,
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

  function intro(): void {
    phase = 'setup';
    banner.hidden = true;
    show(
      paragraph('Stand back until your whole swing fits in the picture.', 'big'),
      paragraph(
        `Part 1: ${TICK_COUNT} ticks (flash and click). Swing once on each tick, like a forehand or backhand return. ` +
          `Part 2: then stand still and talk normally for ${IDLE_MS / 1000} s without swinging. Video stays on this device.`,
        'muted',
      ),
      button('Start', () => void begin()),
      button(`Hand: ${hand} (change)`, () => void askHandedness().then((h) => { handedness.set(h); sensing.setHand(h); intro(); })),
    );
  }

  async function begin(): Promise<void> {
    await presentation.unlock().catch(() => undefined); // silent if audio is unavailable; the flash still works
    log = createFrameLog();
    onsets = [];
    lastFrameT = -Infinity;
    phase = 'ticks';
    banner.hidden = false;
    banner.textContent = 'Get ready…';
    show(paragraph(`Swing on every tick. ${TICK_COUNT} ticks, one every ${(TICK_INTERVAL_MS / 1000).toFixed(1)} s.`));
    metronome.start();
    tickTimes = metronome.tickTimes;
  }

  function startIdle(): void {
    const lastTick = tickTimes[tickTimes.length - 1]!;
    idle = { start: lastTick + IDLE_GRACE_MS, end: lastTick + IDLE_GRACE_MS + IDLE_MS };
    phase = 'idle';
    banner.textContent = "Relax: arm down, stand and talk normally";
    show(paragraph('Idle phase: every detected swing counts as a false trigger.', 'muted'));
    const countdown = setInterval(() => {
      const left = Math.max(0, Math.ceil((idle.end - performance.now()) / 1000));
      banner.textContent = `Stand and talk normally. Don't swing. ${left} s`;
      if (performance.now() >= idle.end + SETTLE_MS) {
        clearInterval(countdown);
        finish();
      }
    }, 200);
  }

  function finish(): void {
    phase = 'done';
    banner.hidden = true;
    const score: SessionScore = scoreSession({ tickTimes, onsets, idle });
    show(
      paragraph(`Detected: ${score.detected} / ${score.total}`, 'big'),
      paragraph(`False triggers: ${score.falseTriggersPerMinute.toFixed(1)} per minute (${score.falseTriggers} in ${IDLE_MS / 1000} s)`, 'big'),
      paragraph(`${log.length} frames logged · hand: ${hand}`, 'muted'),
      button('Download CSV', () => downloadCsv(log.toCsv())),
      button('Run again', intro),
    );
  }

  intro();
}

void main();
