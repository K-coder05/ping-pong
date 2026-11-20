/**
 * Difficulties (spec P2-c): how strong the Opponent plays in a Match, Novice,
 * Intermediate or Expert. Each is a fixed row of the plain `DIFFICULTIES`
 * table, not knobs: a Difficulty never changes during a Match, and its values
 * are tuned offline with the balance harness (P2-g2), not by sliders mid-Rally.
 */

export type Difficulty = 'novice' | 'intermediate' | 'expert';

/** Weakest to strongest. */
export const DIFFICULTY_ORDER: readonly Difficulty[] = Object.freeze(['novice', 'intermediate', 'expert']);

/** The Difficulty a Match plays at when `?difficulty=` doesn't name one. */
export const DEFAULT_DIFFICULTY: Difficulty = 'intermediate';

/**
 * Longest flight of any Opponent Shot, simulated seconds: the same cap Feeds
 * have. A slower ball is a lob that lands short and bounces twice on the
 * player's half. To slow the game further, lower TIME_SCALE; never raise this.
 */
export const OPPONENT_MAX_FLIGHT_S = 1.1;

export interface DifficultyParams {
  /** Mistake chance = mistakeBase + mistakeSlope · d, d the incoming ball's difficulty (0..1). */
  mistakeBase: number;
  mistakeSlope: number;
  /** Share of mistakes that are Pop-ups; the rest split evenly into Errors and Whiffs. */
  popUpShare: number;
  /** Standard deviation of a good Shot's target around its aim, m. */
  scatterM: number;
  /** A good Shot's flight time is uniform in [minFlightS, maxFlightS], simulated s, never above OPPONENT_MAX_FLIGHT_S. */
  minFlightS: number;
  maxFlightS: number;
  /** Largest Topspin or Backspin on a good Shot, rev/s. */
  maxSpinRevs: number;
  /** 0..1 chance of aiming a good Shot at a corner. */
  cornerAim: number;
  /** 0..1 pull toward cross-court: a good Shot's target moves earlyBias · 0.3 m away from the strike's side. */
  earlyBias: number;
}

/** Starting guesses from the spec, to be tuned with P2-g2 and playtests. */
export const DIFFICULTIES: Readonly<Record<Difficulty, Readonly<DifficultyParams>>> = Object.freeze({
  novice: Object.freeze({ mistakeBase: 0.15, mistakeSlope: 0.35, popUpShare: 0.6, scatterM: 0.25, minFlightS: 0.85, maxFlightS: 1.1, maxSpinRevs: 15, cornerAim: 0.1, earlyBias: 0.5 }),
  intermediate: Object.freeze({ mistakeBase: 0.07, mistakeSlope: 0.25, popUpShare: 0.4, scatterM: 0.15, minFlightS: 0.7, maxFlightS: 1.1, maxSpinRevs: 30, cornerAim: 0.4, earlyBias: 0.2 }),
  expert: Object.freeze({ mistakeBase: 0.02, mistakeSlope: 0.15, popUpShare: 0.2, scatterM: 0.07, minFlightS: 0.5, maxFlightS: 1.0, maxSpinRevs: 50, cornerAim: 0.75, earlyBias: 0.05 }),
});

/** The Difficulty a page URL asks for with `?difficulty=novice|intermediate|expert`; DEFAULT_DIFFICULTY otherwise. */
export function difficultyFromSearch(search: string): Difficulty {
  const asked = new URLSearchParams(search).get('difficulty')?.trim().toLowerCase();
  return DIFFICULTY_ORDER.find((name) => name === asked) ?? DEFAULT_DIFFICULTY;
}
