/**
 * Fit a player model from play logs (#27):
 *
 *   npm run fit-player -- logs/*.jsonl --name first-timer --detect-rate 0.9
 *
 * Reads every play log (JSON lines, from the debug panel's "Download play
 * log"), fits timing, speed and vertical path, and writes
 * `fixtures/players/<name>.json`. The detect rate comes from the detection
 * test (detection.html): a Miss can't say whether the player tried.
 *
 * Run by Node's built-in TypeScript support, outside the browser-typed `src/` build.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parsePlayLog } from '../src/game/playLog.ts';
import { fitPlayer } from '../src/tools/fitPlayer.ts';

const files: string[] = [];
let name: string | undefined;
let detectRate: number | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === '--name') {
    name = args[++i];
  } else if (arg === '--detect-rate') {
    detectRate = Number(args[++i]);
  } else if (arg.startsWith('--')) {
    throw new Error(`Unknown flag ${arg}. Flags: --name, --detect-rate`);
  } else {
    files.push(arg);
  }
}
if (files.length === 0 || !name || detectRate === undefined || !Number.isFinite(detectRate)) {
  console.error('Usage: npm run fit-player -- <log.jsonl>... --name <name> --detect-rate <0..1>');
  process.exit(1);
}
if (!/^[\w-]+$/.test(name)) throw new Error(`--name must be letters, digits, - or _, got "${name}"`);

const entries = files.flatMap((file) => parsePlayLog(readFileSync(file, 'utf8')));
const model = fitPlayer(entries, { name, detectRate });
mkdirSync('fixtures/players', { recursive: true });
const out = `fixtures/players/${name}.json`;
writeFileSync(out, JSON.stringify(model, null, 2) + '\n');
console.log(`${entries.length} entries from ${files.length} log(s) -> ${out}`);
console.log(model);
