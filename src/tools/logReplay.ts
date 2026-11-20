import { createPoseInput } from '../input/poseInput.ts';
import type { SwingParams } from '../input/swingDetector.ts';
import type { SwingEvent } from '../input/types.ts';
import type { Hand, Point2 } from '../sensing/landmarks.ts';
import type { SensingFrame } from '../sensing/sensingFrame.ts';
import { idlePhase, scoreSession, type SessionScore } from './detectionScore.ts';

/**
 * Log replay (#12): feeds a downloaded frame-log CSV (debug overlay or
 * detection test) back through the real pose input and Swing detector with
 * any thresholds, so detection can be tuned offline against recorded
 * sessions instead of re-recording each change.
 *
 * It replays the logged *smoothed* wrist and shoulders, so it covers
 * everything after smoothing; One Euro changes need a new recording.
 */

export interface ReplayOptions {
  params: SwingParams;
  /** Video width / height of the recording (not in the log); 4:3 for a typical laptop webcam. */
  aspect?: number;
  /** Timing Offset to judge a detection-test log with, ms (as `scoreSession`). */
  timingOffsetMs?: number;
}

export interface ReplayResult {
  hand: Hand;
  onsets: SwingEvent[];
  /** Metronome tick times of a detection-test log, in tick order; empty for other logs. */
  tickTimes: number[];
  /** The detection-test score with the replayed Onsets; null for a log without ticks. */
  score: SessionScore | null;
}

const DEFAULT_ASPECT = 4 / 3;

export function replayLog(csv: string, { params, aspect = DEFAULT_ASPECT, timingOffsetMs = 0 }: ReplayOptions): ReplayResult {
  const rows = parseCsv(csv);
  let listener: ((frame: SensingFrame) => void) | null = null;
  const input = createPoseInput({ subscribe: (l) => ((listener = l), () => undefined) }, { params: () => params, aspect: () => aspect });
  const onsets: SwingEvent[] = [];
  input.subscribe((swing) => void onsets.push(swing));

  let hand: Hand = 'right';
  const ticks: { index: number; time: number }[] = [];
  for (const row of rows) {
    hand = row.hand === 'left' ? 'left' : 'right';
    listener!(frameFrom(row, hand));
    const index = num(row, 'tick');
    // Older logs only mark the first frame captured after each tick.
    if (index !== null) ticks.push({ index, time: num(row, 'tickTime') ?? num(row, 't')! });
  }
  const tickTimes = ticks.sort((a, b) => a.index - b.index).map((tick) => tick.time);
  const lastTick = tickTimes.at(-1);
  const score =
    lastTick === undefined ? null : scoreSession({ tickTimes, onsets: onsets.map((swing) => swing.t), idle: idlePhase(lastTick), timingOffsetMs });
  return { hand, onsets, tickTimes, score };
}

type CsvRecord = Record<string, string>;

/** Frame-log CSVs hold only numbers and plain words, so no cell is ever quoted. */
function parseCsv(csv: string): CsvRecord[] {
  const [header, ...lines] = csv.split(/\r?\n/).filter((line) => line !== '');
  if (!header) return [];
  const columns = header.split(',');
  return lines.map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? '']));
  });
}

function num(row: CsvRecord, column: string): number | null {
  const cell = row[column];
  return cell === undefined || cell === '' ? null : Number(cell);
}

function point(row: CsvRecord, prefix: string): Point2 | null {
  const x = num(row, `${prefix}X`);
  const y = num(row, `${prefix}Y`);
  return x === null || y === null ? null : { x, y };
}

/** The parts of a sensing frame pose input reads, rebuilt from one log row. */
function frameFrom(row: CsvRecord, hand: Hand): SensingFrame {
  const frame: Pick<SensingFrame, 't' | 'hand' | 'wrist' | 'hittingShoulder' | 'otherShoulder'> = {
    t: num(row, 't') ?? NaN,
    hand,
    wrist: point(row, 'wrist'),
    hittingShoulder: point(row, 'hittingShoulder'),
    otherShoulder: point(row, 'otherShoulder'),
  };
  return frame as SensingFrame;
}
