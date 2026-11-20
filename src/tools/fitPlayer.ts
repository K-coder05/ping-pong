/**
 * Fit a player model from play log entries: the mean and spread of a
 * player's Swing timing, speed and vertical path, so the balance harness can
 * simulate them. The detect rate is not measured here (a Miss doesn't say
 * whether the player tried): it comes from the detection test.
 */

import type { PlayLogEntry } from '../game/playLog.ts';

export interface PlayerModel {
  name: string;
  /** Swing Onset minus Ideal Time, Timing Offset applied. */
  timingMeanMs: number;
  timingSdMs: number;
  /** From detection.html, not from play. */
  detectRate: number;
  /** peakSpeed, shoulder widths/s. */
  speedMean: number;
  speedSd: number;
  vertPathMean: number;
  vertPathSd: number;
}

function meanSd(values: readonly number[]): { mean: number; sd: number } {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.length > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1) : 0;
  return { mean, sd: Math.sqrt(variance) };
}

export function fitPlayer(entries: readonly PlayLogEntry[], options: { name: string; detectRate: number }): PlayerModel {
  const { name, detectRate } = options;
  if (!(detectRate >= 0 && detectRate <= 1)) throw new Error(`The detect rate must be between 0 and 1, got ${detectRate}`);
  // Every Swing has a timing, whatever its outcome; a Miss has none. Speed
  // and vertical path are logged for accepted Swings.
  const deltas = entries.flatMap((e) => (e.delta === undefined ? [] : [e.delta]));
  const accepted = entries.filter((e) => e.peakSpeed !== undefined && e.vertPath !== undefined);
  if (deltas.length < 2 || accepted.length < 2) {
    throw new Error(`Need at least 2 Swings with timing and 2 accepted Swings to fit a player; got ${deltas.length} and ${accepted.length}`);
  }
  const timing = meanSd(deltas);
  const speed = meanSd(accepted.map((e) => e.peakSpeed!));
  const vert = meanSd(accepted.map((e) => e.vertPath!));
  return {
    name,
    timingMeanMs: timing.mean,
    timingSdMs: timing.sd,
    detectRate,
    speedMean: speed.mean,
    speedSd: speed.sd,
    vertPathMean: vert.mean,
    vertPathSd: vert.sd,
  };
}
