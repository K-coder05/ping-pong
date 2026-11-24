/**
 * Balance harness (spec P2-g2, #33): simulated Matches of player models
 * against each Difficulty, headless, to tune DIFFICULTIES before playtests.
 *
 *   npm run balance -- --matches 500 [--seed 1] [--best-of 1|3] [--jobs N]
 *     [--difficulty novice|intermediate|expert] [--model first-timer|you] [--input camera|phone] [--face-angle-sd 15]
 *   npm run balance -- --sweep mistakeBase=0.05:0.25:0.05 --difficulty novice --model first-timer [--input phone]
 *
 * Every Difficulty plays every model with each Input (or only those named),
 * and it prints one row per matchup: the Opponent's Match win rate, the average Rally length
 * (Shots per Rally, the Serve included, Lets left out), the average Points per
 * Game, and the Opponent's mistake rate (Pop-ups, Errors and Whiffs per Shot
 * it chose; Serves aren't counted, the Opponent never Faults), plus the
 * player's errors and the Points won with Shots the Opponent can't reach,
 * for comparison. `--sweep`
 * grid-searches one DifficultyParams field of one Difficulty, on a copy:
 * DIFFICULTIES itself is never changed; it plays the Camera unless `--input`
 * names the Phone.
 *
 * Models: `fixtures/players/<name>.json` (written by `npm run fit-player`)
 * when it exists, else the PROVISIONAL guesses below, flagged in the output.
 * Each model plays with the Camera as fitted, and with the Phone (spec P3-f):
 * the same model, but each Swing carries a Face Angle that matches the
 * incoming Spin with Gaussian error (PHONE_FACE_ANGLE_SD_DEG, or
 * `--face-angle-sd <degrees>`), so Face Angle rather than Lift sets and
 * answers Spin (ADR 0003).
 *
 * Match i of every matchup uses the same seeds (from --seed and i), so rows
 * differ only by Difficulty, model and Input, and the same flags print the same
 * table. Matches run in chunks on a pool of worker threads (`--jobs`, all
 * cores by default); the tallies are sums, so the table doesn't depend on
 * how they are split. The run time goes to stderr, outside the table.
 *
 * Run by Node's built-in TypeScript support, outside the browser-typed `src/` build.
 */
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { PLAYER_END_Z, TABLE_WIDTH } from '../src/game/constants.ts';
import { createGameCore, type MatchEvent } from '../src/game/core.ts';
import type { MatchConfig } from '../src/game/match.ts';
import type { Opponent, RallyEvent } from '../src/game/rally.ts';
import { knobResolverParams } from '../src/game/shotResolver.ts';
import { createBrain, incomingDifficulty, mistakeChance } from '../src/opponent/brain.ts';
import { DIFFICULTIES, DIFFICULTY_ORDER, type Difficulty, type DifficultyParams } from '../src/opponent/difficulty.ts';
import type { PlayerModel } from '../src/tools/fitPlayer.ts';
import { createSimPlayer, type PhoneModel } from '../src/tools/simPlayer.ts';
import { makeRng } from '../src/util/rng.ts';

/**
 * Stand-ins until the real play logs are fitted (P2-g1: `first-timer.json`
 * and `you.json`). Guesses, not measurements: a first-timer swings with
 * about twice the timing spread of a practised player, a little late, and is
 * seen less reliably by the Swing detector.
 */
const PROVISIONAL: Record<string, PlayerModel> = {
  'first-timer': { name: 'first-timer', timingMeanMs: 25, timingSdMs: 90, detectRate: 0.85, speedMean: 6.2, speedSd: 1.3, vertPathMean: 0.6, vertPathSd: 1.2 },
  you: { name: 'you', timingMeanMs: 0, timingSdMs: 45, detectRate: 0.95, speedMean: 6.8, speedSd: 0.9, vertPathMean: 1.2, vertPathSd: 0.9 },
};
const MODEL_ORDER = ['first-timer', 'you'];

/** The Inputs every model plays with (GLOSSARY "Input"). */
type Input = 'camera' | 'phone';
const INPUT_ORDER: Input[] = ['camera', 'phone'];
const INPUT_NAME: Record<Input, string> = { camera: 'Camera', phone: 'Phone' };

/**
 * How far the Phone model's Face Angle strays from the one that matches the
 * incoming Spin, degrees (one standard deviation). Spec P3-f's starting guess,
 * until real Phone logs measure it.
 */
const PHONE_FACE_ANGLE_SD_DEG = 15;

/** Spec P2-g2 targets (guesses; adjust after real playtests): the Opponent's Match win rate, as [min, max]. */
const TARGETS: Partial<Record<`${Difficulty} vs ${string}`, [number, number]>> = {
  'novice vs first-timer': [0, 0.4],
  'intermediate vs you': [0.4, 0.6],
  'expert vs you': [0.7, 1],
};

/** Frame rate of the simulated game loop, as in the browser. Physics substeps are fixed (PHYSICS_DT) whatever it is. */
const FPS = 60;
/** A Match that goes on this long (real seconds) is a bug, not a long Match. */
const MAX_MATCH_S = 4 * 60 * 60;

interface Args {
  matches: number;
  seed: number;
  bestOf: 1 | 3;
  jobs: number;
  difficulties: Difficulty[];
  models: string[];
  /** The Inputs named with --input; null for all of them (the Camera alone in a sweep). */
  inputs: Input[] | null;
  /** The Phone model's Face Angle error, degrees (sd). */
  faceAngleSdDeg: number;
  sweep: { field: keyof DifficultyParams; values: number[] } | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { matches: 500, seed: 1, bestOf: 1, jobs: availableParallelism(), difficulties: [...DIFFICULTY_ORDER], models: [...MODEL_ORDER], inputs: null, faceAngleSdDeg: PHONE_FACE_ANGLE_SD_DEG, sweep: null };
  const value = (i: number, flag: string) => {
    const v = argv[i];
    if (v === undefined) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--matches') args.matches = positiveInt(value(++i, flag), flag);
    else if (flag === '--jobs') args.jobs = positiveInt(value(++i, flag), flag);
    else if (flag === '--seed') args.seed = positiveInt(value(++i, flag), flag, true);
    else if (flag === '--best-of') {
      const n = Number(value(++i, flag));
      if (n !== 1 && n !== 3) throw new Error('--best-of must be 1 or 3');
      args.bestOf = n;
    } else if (flag === '--difficulty') {
      const d = value(++i, flag) as Difficulty;
      if (!DIFFICULTY_ORDER.includes(d)) throw new Error(`--difficulty must be one of ${DIFFICULTY_ORDER.join(', ')}`);
      args.difficulties = [d];
    } else if (flag === '--model') args.models = [value(++i, flag)];
    else if (flag === '--input') {
      const input = value(++i, flag) as Input;
      if (!INPUT_ORDER.includes(input)) throw new Error(`--input must be one of ${INPUT_ORDER.join(', ')}`);
      args.inputs = [input];
    } else if (flag === '--face-angle-sd') {
      const raw = value(++i, flag);
      const sd = Number(raw);
      if (!Number.isFinite(sd) || sd < 0) throw new Error(`${flag} needs a number of degrees, 0 or more, got "${raw}"`);
      args.faceAngleSdDeg = sd;
    } else if (flag === '--sweep') args.sweep = parseSweep(value(++i, flag));
    else throw new Error(`Unknown flag ${flag}. Flags: --matches, --seed, --best-of, --jobs, --difficulty, --model, --input, --face-angle-sd, --sweep`);
  }
  if (args.sweep && (args.difficulties.length !== 1 || args.models.length !== 1)) {
    throw new Error('--sweep needs one --difficulty and one --model');
  }
  return args;
}

function positiveInt(raw: string, flag: string, allowZero = false): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1)) throw new Error(`${flag} needs a whole number, got "${raw}"`);
  return n;
}

/** `field=from:to:step`, e.g. `mistakeBase=0.05:0.25:0.05`. */
function parseSweep(raw: string): Args['sweep'] {
  const match = /^(\w+)=([^:]+):([^:]+):([^:]+)$/.exec(raw);
  if (!match) throw new Error(`--sweep wants field=from:to:step, got "${raw}"`);
  const field = match[1] as keyof DifficultyParams;
  if (!(field in DIFFICULTIES.novice)) throw new Error(`--sweep: no DifficultyParams field "${field}". Fields: ${Object.keys(DIFFICULTIES.novice).join(', ')}`);
  const [from, to, step] = [match[2], match[3], match[4]].map(Number) as [number, number, number];
  if (![from, to, step].every(Number.isFinite) || step <= 0 || to < from) throw new Error(`--sweep: bad range in "${raw}"`);
  const values: number[] = [];
  // Rounded so 0.05 steps don't drift into 0.15000000000000002.
  for (let k = 0; from + k * step <= to + step * 1e-9; k++) values.push(Number((from + k * step).toFixed(10)));
  return { field, values };
}

/** The model named `name`: the fitted fixture when there is one, else the provisional guess. */
function loadModel(name: string): { model: PlayerModel; source: string } {
  const path = `fixtures/players/${name}.json`;
  if (existsSync(path)) return { model: JSON.parse(readFileSync(path, 'utf8')) as PlayerModel, source: path };
  const guess = PROVISIONAL[name];
  if (!guess) throw new Error(`No model "${name}": ${path} doesn't exist and there's no provisional one (${Object.keys(PROVISIONAL).join(', ')})`);
  return { model: guess, source: `PROVISIONAL guess (${path} not found)` };
}

interface Tally {
  matches: number;
  opponentWins: number;
  rallies: number;
  rallyShots: number;
  games: number;
  points: number;
  /** Shots the Opponent chose (chooseShot calls), and how many were mistakes of each kind. */
  choices: number;
  popUps: number;
  errors: number;
  whiffs: number;
  /** Shots the player had to play (every Incoming toward the player, tosses included), and Rally Ends against the player. */
  faced: number;
  playerLost: number;
  /** Points the player won with a Shot the Opponent never got to strike: it bounced twice on the Opponent's half before its end line, so it had no Ideal Time there. */
  unreachable: number;
}

const emptyTally = (): Tally => ({ matches: 0, opponentWins: 0, rallies: 0, rallyShots: 0, games: 0, points: 0, choices: 0, popUps: 0, errors: 0, whiffs: 0, faced: 0, playerLost: 0, unreachable: 0 });

/**
 * The brain at `params`, counting its mistakes. A choice is a mistake when the
 * brain's first draw for it is under the spec's mistake chance (mistakeBase +
 * mistakeSlope · d, from the exported `mistakeChance` and `incomingDifficulty`);
 * its kind is a Whiff (`'whiff'`), an Error (target off the table: a good
 * Shot or Pop-up never is), or else a Pop-up. The draws pass straight
 * through, so the Match plays exactly as with the bare brain.
 */
function countingBrain(params: DifficultyParams, tally: Tally): Opponent {
  const brain = createBrain(params);
  return {
    chooseServe: (random) => brain.chooseServe(random),
    chooseShot(incoming, random) {
      let first: number | null = null;
      const choice = brain.chooseShot(incoming, () => {
        const r = random();
        first ??= r;
        return r;
      });
      tally.choices++;
      if (first !== null && first < mistakeChance(params, incomingDifficulty(incoming))) {
        if (choice === 'whiff') tally.whiffs++;
        else if (Math.abs(choice.target.x) > TABLE_WIDTH / 2 || choice.target.z > PLAYER_END_Z) tally.errors++;
        else tally.popUps++;
      }
      return choice;
    },
  };
}

/** Seed for stream `stream` of Match `index` under base seed `seed` (a small integer hash, so nearby seeds don't correlate). */
function matchSeed(seed: number, index: number, stream: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(index + 1, 0xc2b2ae35) ^ Math.imul(stream + 1, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Play one Match of `model` (with the Phone when `phone` is set, else the Camera) against the Opponent at `params` and add it to `tally`. */
function playMatch(params: DifficultyParams, model: PlayerModel, phone: PhoneModel | null, config: MatchConfig, seed: number, index: number, tally: Tally): void {
  const core = createGameCore({
    random: makeRng(matchSeed(seed, index, 0)),
    resolverParams: knobResolverParams,
    hand: () => 'right',
    mode: 'match',
    opponent: countingBrain(params, tally),
    match: config,
  });
  const player = createSimPlayer(model, core, makeRng(matchSeed(seed, index, 1)), phone ? { phone } : {});
  let nowMs = 0;
  player.subscribe((swing) => core.swing(swing, nowMs));
  let shots = 0;
  /** The player's latest Shot in this Rally has no Ideal Time at the Opponent's end: the Opponent has no chance at it. */
  let unreachable = false;
  core.onShot((e) => {
    // The core has acted on the contact: in a Rally, a Shot the Opponent can play has its plan already.
    if (e.type === 'contact') unreachable = core.match?.phase === 'rally' && core.opponentPlan === null;
  });
  core.onRally((e: RallyEvent) => {
    if (e.type === 'shot') shots = e.shotIndex + 1;
    else if (e.type === 'end') {
      tally.rallies++;
      tally.rallyShots += shots;
      if (e.loser === 'player') tally.playerLost++;
      else if (e.end === 'unreturned' && unreachable) tally.unreachable++;
      unreachable = false;
    }
  });
  core.onIncoming((incoming) => {
    if (incoming.receiver === 'player') tally.faced++;
  });
  core.onMatch((e: MatchEvent) => {
    if (e.type !== 'point') return;
    tally.points++;
    if (e.match.phase === 'game-over' || e.match.phase === 'match-over') tally.games++;
  });
  const frameMs = 1000 / FPS;
  for (let frame = 0; core.match?.phase !== 'match-over'; frame++) {
    if (frame > MAX_MATCH_S * FPS) throw new Error(`Match ${index} (seed ${seed}) didn't end in ${MAX_MATCH_S} s`);
    nowMs += frameMs;
    player.advance(nowMs);
    core.frame({ nowMs, elapsedSeconds: 1 / FPS });
  }
  tally.matches++;
  if (core.match.winner === 'opponent') tally.opponentWins++;
}

/** A chunk of one row's Matches, played in a worker: Matches [from, to) of `params` against `model`, with the Phone if `phone` is set. */
interface Job {
  row: number;
  params: DifficultyParams;
  model: PlayerModel;
  phone: PhoneModel | null;
  bestOf: 1 | 3;
  seed: number;
  from: number;
  to: number;
}

/** Matches per Job: small enough to spread a single row over every worker, big enough that messaging is noise. */
const CHUNK = 25;

function runJob(job: Job): Tally {
  const tally = emptyTally();
  const config: MatchConfig = { pointsToWin: 11, winBy: 2, bestOf: job.bestOf };
  for (let i = job.from; i < job.to; i++) playMatch(job.params, job.model, job.phone, config, job.seed, i, tally);
  return tally;
}

function addTally(into: Tally, t: Tally): void {
  for (const key of Object.keys(into) as (keyof Tally)[]) into[key] += t[key];
}

/** Play every row's Matches on a pool of `jobs` worker threads; one Tally per row, in order. */
async function playRows(rows: { params: DifficultyParams; model: PlayerModel; input: Input }[], args: Args): Promise<Tally[]> {
  const queue: Job[] = [];
  rows.forEach(({ params, model, input }, row) => {
    const phone: PhoneModel | null = input === 'phone' ? { faceAngleSdDeg: args.faceAngleSdDeg } : null;
    for (let from = 0; from < args.matches; from += CHUNK) {
      queue.push({ row, params, model, phone, bestOf: args.bestOf, seed: args.seed, from, to: Math.min(args.matches, from + CHUNK) });
    }
  });
  const tallies = rows.map(emptyTally);
  const workers = Math.min(args.jobs, queue.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      const worker = new Worker(new URL(import.meta.url));
      try {
        for (let job = queue.shift(); job; job = queue.shift()) {
          const current = job;
          const tally = await new Promise<Tally>((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.postMessage(current);
          });
          worker.removeAllListeners('error');
          addTally(tallies[current.row]!, tally);
        }
      } finally {
        await worker.terminate();
      }
    }),
  );
  return tallies;
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

/**
 * The table row cells for a Tally: Opponent wins (with a 95% margin), Rally
 * length, Points per Game, the Opponent's mistakes (all, then by kind), and
 * for comparison the player's errors: Rally Ends against the player per Shot
 * they had to play (a missed toss is served again, so it costs nothing);
 * and the share of all Points the player won with a Shot the Opponent could
 * never strike (a short ball that bounces twice on its half has no Ideal Time).
 */
function cells(t: Tally): string[] {
  const win = t.opponentWins / t.matches;
  const margin = 1.96 * Math.sqrt((win * (1 - win)) / t.matches);
  const mistakes = t.popUps + t.errors + t.whiffs;
  return [
    `${pct(win)} ± ${(100 * margin).toFixed(1)}`,
    (t.rallyShots / t.rallies).toFixed(2),
    (t.points / t.games).toFixed(1),
    pct(mistakes / t.choices),
    `${pct(t.popUps / t.choices)} / ${pct(t.errors / t.choices)} / ${pct(t.whiffs / t.choices)}`,
    pct(t.playerLost / t.faced),
    pct(t.unreachable / t.points),
  ];
}

function targetCell(difficulty: Difficulty, model: string, t: Tally): string {
  const target = TARGETS[`${difficulty} vs ${model}`];
  if (!target) return '';
  const [min, max] = target;
  const win = t.opponentWins / t.matches;
  const text = min === 0 ? `≤ ${pct(max)}` : max === 1 ? `≥ ${pct(min)}` : `${pct(min)}–${pct(max)}`;
  return `${text}: ${win >= min && win <= max ? 'met' : 'NOT met'}`;
}

function printTable(head: string[], rows: string[][]): void {
  console.log(`| ${head.join(' | ')} |`);
  console.log(`| ${head.map(() => '---').join(' | ')} |`);
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const models = args.models.map((name) => ({ name, ...loadModel(name) }));
  const started = performance.now();

  const game = args.bestOf === 1 ? 'one Game to 11' : 'best of three Games to 11';
  console.log(`Balance: ${args.matches} Matches per row (${game}), seed ${args.seed}, ${FPS} fps, default knobs`);
  for (const { name, source, model } of models) {
    console.log(`  ${name}: ${source}: timing ${model.timingMeanMs} ± ${model.timingSdMs} ms, detect ${model.detectRate}, speed ${model.speedMean} ± ${model.speedSd}, vertPath ${model.vertPathMean} ± ${model.vertPathSd}`);
  }
  const inputs = args.inputs ?? (args.sweep ? ['camera' as const] : INPUT_ORDER);
  if (inputs.includes('phone')) {
    console.log(`  With the Phone: the same models, Face Angle matching the incoming Spin ± ${args.faceAngleSdDeg}° (sd), vertPath 0`);
  }
  console.log('');

  const STATS = ['Opponent wins (95%)', 'Rally length', 'Points/Game', 'Opponent mistakes', 'Pop-up / Error / Whiff', 'Player errors', 'Unreachable Points'];
  if (args.sweep) {
    const { field, values } = args.sweep;
    const difficulty = args.difficulties[0]!;
    const { name, model } = models[0]!;
    const input = inputs[0]!;
    console.log(`Sweep: ${difficulty} ${field} (now ${DIFFICULTIES[difficulty][field]}) vs ${name} with the ${INPUT_NAME[input]}`);
    console.log('');
    const tallies = await playRows(values.map((v) => ({ params: { ...DIFFICULTIES[difficulty], [field]: v }, model, input })), args);
    printTable([field, ...STATS, 'Target'], tallies.map((t, i) => [String(values[i]), ...cells(t), targetCell(difficulty, name, t)]));
  } else {
    const matchups = args.difficulties.flatMap((difficulty) =>
      models.flatMap(({ name, model }) => inputs.map((input) => ({ difficulty, name, model, input, params: DIFFICULTIES[difficulty] }))),
    );
    const tallies = await playRows(matchups, args);
    printTable(
      ['Difficulty', 'Player', 'Input', ...STATS, 'Target'],
      tallies.map((t, i) => {
        const { difficulty, name, input } = matchups[i]!;
        return [difficulty, name, INPUT_NAME[input], ...cells(t), targetCell(difficulty, name, t)];
      }),
    );
  }
  console.error(`\n${((performance.now() - started) / 1000).toFixed(1)} s on ${args.jobs} worker thread(s)`);
}

if (isMainThread) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
} else {
  parentPort!.on('message', (job: Job) => parentPort!.postMessage(runJob(job)));
}
