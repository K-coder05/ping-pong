/**
 * The play log: one JSON line per Shot coming to the player, so real players'
 * timing, speed and vertical path can be measured and fitted into a player
 * model (`src/tools/fitPlayer.ts`) for the balance harness.
 *
 * A recorder is fed the Feeder's Feeds (for the Ideal Time) and the
 * resolver's Shot events; it writes one entry per Feed when the Feed's
 * outcome is known. No DOM, no clock, no randomness.
 */

import type { ShotEvent } from './shotResolver.ts';

export type PlayLogMode = 'drill' | 'match';
export type PlayLogOutcome = 'accepted' | 'early' | 'late' | 'miss';

export interface PlayLogEntry {
  mode: PlayLogMode;
  /** The Shot's Ideal Time, performance.now() ms. */
  idealAtMs: number;
  outcome: PlayLogOutcome;
  /** Swing Onset minus Ideal Time, Timing Offset applied, ms. Absent for a Miss. */
  delta?: number;
  /** Swing speed, shoulder widths/s. Only for an accepted Swing. */
  peakSpeed?: number;
  /** Vertical wrist speed at Onset, shoulder widths/s; + = up. Only for an accepted Swing. */
  vertPath?: number;
}

const MODES: readonly string[] = ['drill', 'match'];
const OUTCOMES: readonly string[] = ['accepted', 'early', 'late', 'miss'];

function isEntry(value: unknown): value is PlayLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const optionalNumber = (x: unknown) => x === undefined || (typeof x === 'number' && Number.isFinite(x));
  return (
    typeof v.mode === 'string' &&
    MODES.includes(v.mode) &&
    typeof v.idealAtMs === 'number' &&
    Number.isFinite(v.idealAtMs) &&
    typeof v.outcome === 'string' &&
    OUTCOMES.includes(v.outcome) &&
    optionalNumber(v.delta) &&
    optionalNumber(v.peakSpeed) &&
    optionalNumber(v.vertPath)
  );
}

/** Entries as JSON lines (newline-terminated), the file format. */
export function serializePlayLog(entries: readonly PlayLogEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry) + '\n').join('');
}

/** Parse JSON lines back into entries; blank lines are skipped. Throws, naming the line, on a bad one. */
export function parsePlayLog(text: string): PlayLogEntry[] {
  const entries: PlayLogEntry[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Play log line ${i + 1} is not JSON`);
    }
    if (!isEntry(value)) throw new Error(`Play log line ${i + 1} is not a play log entry`);
    entries.push(value);
  });
  return entries;
}

export interface PlayLogRecorder {
  /** A Feed was launched: `idealAtMs` is its Ideal Time (null if it never reaches the player: not logged). */
  startFeed(idealAtMs: number | null): void;
  /** A resolver event for the current Feed. */
  shot(event: ShotEvent): void;
  /** Entries so far. */
  readonly entries: readonly PlayLogEntry[];
  /** The log as JSON lines. */
  toText(): string;
}

export function createPlayLogRecorder(options: { mode: PlayLogMode }): PlayLogRecorder {
  const entries: PlayLogEntry[] = [];
  let idealAtMs: number | null = null;

  function write(rest: Omit<PlayLogEntry, 'mode' | 'idealAtMs'>): void {
    if (idealAtMs === null) return;
    entries.push({ mode: options.mode, idealAtMs, ...rest });
    idealAtMs = null; // one entry per Feed
  }

  return {
    startFeed(next) {
      idealAtMs = next;
    },
    shot(event) {
      switch (event.type) {
        case 'accepted':
          write({ outcome: 'accepted', delta: event.delta, peakSpeed: event.swing.peakSpeed, vertPath: event.swing.vertPath });
          break;
        case 'early':
          if (event.final) write({ outcome: 'early', delta: event.delta });
          break;
        case 'late':
          write({ outcome: 'late', delta: event.delta });
          break;
        case 'miss':
          write({ outcome: 'miss' });
          break;
        default:
          break;
      }
    },
    get entries() {
      return entries;
    },
    toText() {
      return serializePlayLog(entries);
    },
  };
}
