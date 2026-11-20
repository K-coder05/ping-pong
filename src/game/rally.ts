/**
 * The Rally (spec P2-b): any Shot heading to either side gets an Ideal Time
 * at the receiver's end, the receiver (player or Opponent) gets one chance to
 * return it, and a referee ends the Rally with its Rally End and loser.
 *
 * Pure and headless: `findIdealTime` simulates a just-launched Shot ahead with
 * the same integrator as the live ball, and the referee only sees what it is
 * told (each Shot's launch, the ball's events, the receiver's missed chance).
 */

import type { ShotIntent } from './solver.ts';
import { simulate, type BallEvent, type BallState, type Vec3 } from './ball.ts';
import { OPPONENT_END_Z, PHYSICS_DT, PLAYER_END_Z } from './constants.ts';
import { otherSide, type Side } from './side.ts';

/** When and where a Shot reaches the receiver's end of the table, after its bounce there. */
export interface IdealTime {
  /** Simulated seconds after launch. Convert to real time with `simSecondsToRealMs`. */
  simSeconds: number;
  /** Ball centre as it crosses the receiver's end line. */
  position: Vec3;
}

/** Longest look-ahead: any playable Shot reaches the receiver's end well inside this. */
const IDEAL_TIME_HORIZON_S = 4;

/** The receiver's end line: the player's at +z, the Opponent's at −z. */
function endLineZ(receiver: Side): number {
  return receiver === 'player' ? PLAYER_END_Z : OPPONENT_END_Z;
}

/**
 * Simulate a just-launched Shot ahead to its Ideal Time, and the ball there
 * (the strike). Null if its first bounce isn't on the receiver's half, or it
 * never crosses the receiver's end line while live (net, out, a second bounce).
 * The crossing is interpolated within its substep: the strike's position is
 * exactly the Ideal Time's; its velocity and Spin are the substep's end.
 */
export function lookAhead(ball: BallState, receiver: Side): { ideal: IdealTime; strike: BallState } | null {
  const endZ = endLineZ(receiver);
  // Distance past the end line, positive once crossed, for either direction.
  const past = (z: number) => (receiver === 'player' ? z - endZ : endZ - z);
  let previous = ball;
  let firstBounce: Side | null = null;
  let found: { ideal: IdealTime; strike: BallState } | null = null;
  simulate(ball, {
    maxTime: IDEAL_TIME_HORIZON_S,
    until: (state, time, events) => {
      const before = previous;
      previous = state;
      if (firstBounce === null) {
        const bounce = events.find((e) => e.type === 'bounce');
        if (bounce?.type === 'bounce') firstBounce = bounce.half;
      }
      if (firstBounce !== null && firstBounce !== receiver) return true;
      if (state.status !== 'live') return true;
      if (state.lastBounceHalf !== receiver || past(state.position.z) < 0) return false;
      const a = before.position;
      const b = state.position;
      const f = b.z === a.z ? 1 : Math.min(1, Math.max(0, (endZ - a.z) / (b.z - a.z)));
      const position = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
      found = { ideal: { simSeconds: time - (1 - f) * PHYSICS_DT, position }, strike: { ...state, position: { ...position } } };
      return true;
    },
  });
  return found;
}

/** When the Shot's centre crosses the receiver's end line after bouncing on the receiver's half; null if it never does. */
export function findIdealTime(ball: BallState, receiver: Side): IdealTime | null {
  return lookAhead(ball, receiver)?.ideal ?? null;
}

/** What a receiver needs to decide how to play an incoming Shot. */
export interface Incoming {
  readonly receiver: Side;
  /** The Shot at launch. */
  readonly ball: BallState;
  /** performance.now() at launch. */
  readonly launchedAtMs: number;
  readonly ideal: IdealTime;
  /** The Ideal Time on the performance.now() clock, converted with TIME_SCALE at launch. */
  readonly idealAtMs: number;
  /** The ball at the Ideal Time (position, velocity, Spin). */
  readonly strike: BallState;
  /** 0 = the Rally's first Shot. */
  readonly shotIndex: number;
}

/** Why a Rally is over (GLOSSARY "Rally End"). */
export type RallyEnd = 'net' | 'out' | 'own-half' | 'unreturned';

export type RallyEvent =
  | { readonly type: 'shot'; readonly atMs: number; readonly by: Side; readonly shotIndex: number }
  | { readonly type: 'bounce'; readonly atMs: number; readonly half: Side }
  | { readonly type: 'end'; readonly atMs: number; readonly end: RallyEnd; readonly loser: Side };

export interface Opponent {
  /**
   * Called when a Shot toward the Opponent launches (ADR 0002); the choice is
   * applied at the Ideal Time, struck from `contactPoint(strike.position)`.
   */
  chooseShot(incoming: Incoming, random: () => number): ShotIntent | 'whiff';
}

/** The referee's call: the Rally End and the side that loses the Point. */
export interface RallyEndCall {
  readonly end: RallyEnd;
  readonly loser: Side;
}

/**
 * Pure referee for one Rally at a time. Tell it each Shot's launch (`shot`),
 * then every event of the ball in play, in order (`ballEvent`), and when the
 * receiver's chance passes without a Return (`noReturn`: an Opponent Whiff, a
 * player Early, Late or Miss). Each returns the Rally End when it decides one.
 *
 * Rules:
 * - Before its first bounce, a Shot into the net is `net`, off the table is
 *   `out`, and a first bounce on the hitter's half is `own-half`: all against
 *   the hitter. A Net-cord (`cord`) plays on.
 * - After a first bounce on the receiver's half, the next bounce (on either
 *   half), the ball leaving the table or meeting the net is `unreturned`,
 *   against the receiver, but only once the receiver's chance has passed: a
 *   Swing in the Hit Window always strikes the ball (ADR 0001), even one
 *   that has dropped past the end of the table, and that new Shot cancels it.
 */
export interface Referee {
  /** The Rally End, once called; null while the Rally is on. */
  readonly ended: RallyEndCall | null;
  /** A Shot launched by `by` (Shot 0 starts the Rally): judge it from here on. */
  shot(by: Side): void;
  /** One event of the ball in play since its Shot launched. */
  ballEvent(event: BallEvent): RallyEndCall | null;
  /** The receiver's chance at the current Shot passed with no Return. */
  noReturn(): RallyEndCall | null;
  /** Forget the Rally, for the next one. */
  reset(): void;
}

export function createReferee(): Referee {
  let ended: RallyEndCall | null = null;
  let hitter: Side | null = null;
  /** The current Shot has bounced on the receiver's half. */
  let bounced = false;
  /** After that bounce, the ball has bounced again, left the table or met the net. */
  let ballDone = false;
  /** The receiver's chance has passed. */
  let chanceOver = false;

  function end(rallyEnd: RallyEnd, loser: Side): RallyEndCall {
    ended = { end: rallyEnd, loser };
    return ended;
  }

  function unreturnedIfDue(): RallyEndCall | null {
    return ballDone && chanceOver && hitter ? end('unreturned', otherSide(hitter)) : null;
  }

  return {
    get ended() {
      return ended;
    },
    shot(by) {
      if (ended) return;
      hitter = by;
      bounced = false;
      ballDone = false;
      chanceOver = false;
    },
    ballEvent(event) {
      if (ended || !hitter || event.type === 'cord') return null;
      if (!bounced) {
        if (event.type === 'net') return end('net', hitter);
        if (event.type === 'out') return end('out', hitter);
        if (event.half === hitter) return end('own-half', hitter);
        bounced = true;
        return null;
      }
      ballDone = true;
      return unreturnedIfDue();
    },
    noReturn() {
      if (ended || !hitter) return null;
      chanceOver = true;
      return unreturnedIfDue();
    },
    reset() {
      ended = null;
      hitter = null;
      bounced = false;
      ballDone = false;
      chanceOver = false;
    },
  };
}
