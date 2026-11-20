/**
 * Replay recorded frame logs through the Swing detector (#12):
 *
 *   npm run replay -- pose_csvs/*.csv [--swing-on 5.2] [--swing-off 0.5]
 *     [--cooldown 700] [--min-rise 0.5] [--offset 390] [--aspect 1.333]
 *
 * Thresholds default to the knob defaults in `constants.ts`. For each log it
 * prints the Onsets, and for a detection-test log the score plus how long
 * after each tick its Onsets came, so a stale Timing Offset is easy to spot.
 *
 * It replays the logged smoothed wrist and shoulders: the numbers reflect the
 * One Euro settings each log was recorded with, not the current knobs.
 *
 * A thin wrapper around `replayLog` (src/tools/logReplay.ts); run by Node's
 * built-in TypeScript support, outside the browser-typed `src/` build.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { knobSwingParams } from '../src/input/poseInput.ts';
import { DETECTION_WINDOW_MS, idlePhase, isTickDetected } from '../src/tools/detectionScore.ts';
import { replayLog } from '../src/tools/logReplay.ts';

const FLAGS = { '--swing-on': 'swingOn', '--swing-off': 'swingOff', '--cooldown': 'cooldownMs', '--min-rise': 'minRise', '--offset': 'offset', '--aspect': 'aspect' } as const;

const files: string[] = [];
const values: Partial<Record<(typeof FLAGS)[keyof typeof FLAGS], number>> = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg in FLAGS) {
    const value = Number(args[++i]);
    if (!Number.isFinite(value)) throw new Error(`${arg} needs a number`);
    values[FLAGS[arg as keyof typeof FLAGS]] = value;
  } else if (arg.startsWith('--')) {
    throw new Error(`Unknown flag ${arg}. Flags: ${Object.keys(FLAGS).join(', ')}`);
  } else {
    files.push(arg);
  }
}
if (files.length === 0) {
  console.error('Usage: npm run replay -- <log.csv>... [--swing-on n] [--swing-off n] [--cooldown ms] [--min-rise n] [--offset ms] [--aspect w/h]');
  process.exit(1);
}

const { offset = 0, aspect, ...overrides } = values;
const params = { ...knobSwingParams(), ...overrides };
console.log(`swingOn ${params.swingOn} · swingOff ${params.swingOff} · cooldown ${params.cooldownMs} ms · minRise ${params.minRise} · Timing Offset ${offset} ms`);
console.log('(Replays each log as smoothed when recorded: One Euro knobs are not applied.)\n');

const round = (n: number) => Math.round(n);
for (const file of files) {
  const { hand, onsets, tickTimes, score } = replayLog(readFileSync(file, 'utf8'), { params, aspect, timingOffsetMs: offset });
  const sides = (side: string) => onsets.filter((swing) => swing.side === side).length;
  console.log(`${basename(file)} (${hand} hand): ${onsets.length} Onsets (${sides('forehand')} Forehand, ${sides('backhand')} Backhand)`);
  if (!score) {
    console.log();
    continue;
  }
  console.log(`  Detected ${score.detected} / ${score.total} · false triggers ${score.falseTriggers} (${score.falseTriggersPerMinute.toFixed(1)}/min)`);
  // Each tick's Onsets, from its window's start up to the next tick's (the idle phase after the last).
  const onsetTimes = onsets.map((swing) => swing.t);
  const idleStart = idlePhase(tickTimes.at(-1)!).start;
  const afterTick = tickTimes.map((tick, i) => {
    const end = (tickTimes[i + 1] ?? idleStart) - DETECTION_WINDOW_MS;
    return onsetTimes.filter((t) => t >= tick - DETECTION_WINDOW_MS && t < end).map((t) => t - tick);
  });
  const cells = afterTick.map((ms, i) => `${i}:${ms.map(round).join('/') || '–'}${isTickDetected(tickTimes[i]!, onsetTimes, offset) ? '' : '*'}`);
  console.log(`  Onsets after each tick, ms (* = not detected): ${cells.join(' ')}`);
  const firsts = afterTick.flatMap((ms) => ms.slice(0, 1)).sort((a, b) => a - b);
  if (firsts.length) console.log(`  Median ${round(firsts[Math.floor(firsts.length / 2)]!)} ms after the tick; the windows are centred on the Timing Offset, ${offset} ms`);
  console.log();
}
